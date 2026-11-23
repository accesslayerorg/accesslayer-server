import {
   createCipheriv,
   createDecipheriv,
   createHash,
   createHmac,
   randomBytes,
   timingSafeEqual,
} from 'crypto';
import { envConfig } from '../../config';
import type { AdminJwtPayload } from '../../types/auth.types';
import { signAdminSessionToken } from '../../utils/jwt.utils';
import { prisma } from '../../utils/prisma.utils';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_SKEW_STEPS = 1;
export const TOTP_DIGITS = 6;
export const TOTP_RECOVERY_CODE_COUNT = 10;
export const TOTP_MAX_ATTEMPTS = 5;
export const TOTP_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ENCRYPTION_VERSION = 'v1';

interface TotpRecord {
   userId: string;
   secretEnc: string;
   enabledAt: Date | null;
   recoveryHashes: string[];
   lastUsedStep: number | null;
   updatedAt: Date;
}

interface VerificationAttempt {
   count: number;
   resetAt: number;
}

const verificationAttempts = new Map<string, VerificationAttempt>();

export class AdminTotpServiceError extends Error {
   constructor(
      message: string,
      public readonly statusCode: number,
      public readonly code: string,
      public readonly retryAfterSeconds?: number
   ) {
      super(message);
      this.name = new.target.name;
   }
}

export class AdminTotpNotConfiguredError extends AdminTotpServiceError {
   constructor() {
      super(
         'Two-factor authentication is not configured for this admin',
         409,
         'TOTP_NOT_CONFIGURED'
      );
   }
}

export class AdminTotpAlreadyEnabledError extends AdminTotpServiceError {
   constructor() {
      super(
         'Two-factor authentication is already enabled for this admin',
         409,
         'TOTP_ALREADY_ENABLED'
      );
   }
}

export class AdminTotpInvalidCodeError extends AdminTotpServiceError {
   constructor() {
      super(
         'Invalid or already used verification code',
         401,
         'INVALID_TOTP_CODE'
      );
   }
}

export class AdminTotpRateLimitError extends AdminTotpServiceError {
   constructor(retryAfterSeconds: number) {
      super(
         'Too many two-factor verification attempts',
         429,
         'RATE_LIMIT_EXCEEDED',
         retryAfterSeconds
      );
   }
}

export interface AdminTotpSetupResult {
   otpauthUri: string;
   recoveryCodes: string[];
}

export interface AdminTotpLoginInput {
   code?: string;
   recoveryCode?: string;
}

export interface AdminTotpLoginResult {
   accessToken: string;
   tokenType: 'Bearer';
   expiresIn: number;
}

function base32Encode(buffer: Buffer): string {
   let bits = 0;
   let value = 0;
   let encoded = '';

   for (const byte of buffer) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
         encoded += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
         bits -= 5;
      }
   }

   if (bits > 0) {
      encoded += BASE32_ALPHABET[(value << (5 - bits)) & 31];
   }

   return encoded;
}

function encryptionKey(): Buffer {
   return createHash('sha256').update(envConfig.APP_SECRET).digest();
}

function encryptSecret(secret: Buffer, userId: string): string {
   const iv = randomBytes(12);
   const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
   cipher.setAAD(Buffer.from(userId, 'utf8'));
   const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);

   return [
      ENCRYPTION_VERSION,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
   ].join('.');
}

function decryptSecret(secretEnc: string, userId: string): Buffer {
   const [version, ivPart, tagPart, ciphertextPart] = secretEnc.split('.');
   if (
      version !== ENCRYPTION_VERSION ||
      !ivPart ||
      !tagPart ||
      !ciphertextPart
   ) {
      throw new Error('Invalid encrypted TOTP secret');
   }

   const decipher = createDecipheriv(
      'aes-256-gcm',
      encryptionKey(),
      Buffer.from(ivPart, 'base64url')
   );
   decipher.setAAD(Buffer.from(userId, 'utf8'));
   decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

   return Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, 'base64url')),
      decipher.final(),
   ]);
}

function currentStep(now: number = Date.now()): number {
   return Math.floor(now / 1000 / TOTP_STEP_SECONDS);
}

function totpCode(secret: Buffer, step: number): string {
   const counter = Buffer.alloc(8);
   counter.writeBigUInt64BE(BigInt(step));

   const digest = createHmac('sha1', secret).update(counter).digest();
   const offset = digest[digest.length - 1] & 0x0f;
   const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;

   return value.toString().padStart(TOTP_DIGITS, '0');
}

function codesEqual(expected: string, actual: string): boolean {
   const expectedBuffer = Buffer.from(expected, 'utf8');
   const actualBuffer = Buffer.from(actual, 'utf8');
   return (
      expectedBuffer.length === actualBuffer.length &&
      timingSafeEqual(expectedBuffer, actualBuffer)
   );
}

function otpauthUri(userId: string, secret: string): string {
   const issuer = new URL(envConfig.BACKEND_URL).host;
   const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(userId)}`;
   const params = new URLSearchParams({
      secret,
      issuer,
      algorithm: 'SHA1',
      digits: String(TOTP_DIGITS),
      period: String(TOTP_STEP_SECONDS),
   });

   return `otpauth://totp/${label}?${params.toString()}`;
}

export function normalizeRecoveryCode(code: string): string {
   return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function hashRecoveryCode(code: string): string {
   return createHmac('sha256', encryptionKey())
      .update(normalizeRecoveryCode(code))
      .digest('hex');
}

function generateRecoveryCodes(): string[] {
   return Array.from({ length: TOTP_RECOVERY_CODE_COUNT }, () => {
      const raw = base32Encode(randomBytes(6));
      return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
   });
}

function assertVerificationAllowed(adminId: string): void {
   const now = Date.now();
   let attempt = verificationAttempts.get(adminId);

   if (!attempt || now >= attempt.resetAt) {
      attempt = {
         count: 0,
         resetAt: now + TOTP_RATE_LIMIT_WINDOW_MS,
      };
      verificationAttempts.set(adminId, attempt);
   }

   if (attempt.count >= TOTP_MAX_ATTEMPTS) {
      throw new AdminTotpRateLimitError(
         Math.max(1, Math.ceil((attempt.resetAt - now) / 1000))
      );
   }

   attempt.count += 1;

   if (verificationAttempts.size > 1000) {
      for (const [key, state] of verificationAttempts) {
         if (now >= state.resetAt) {
            verificationAttempts.delete(key);
         }
      }
   }
}

function clearVerificationAttempts(adminId: string): void {
   verificationAttempts.delete(adminId);
}

export function resetAdminTotpRateLimit(adminId?: string): void {
   if (adminId) {
      verificationAttempts.delete(adminId);
      return;
   }
   verificationAttempts.clear();
}

async function loadTotp(adminId: string): Promise<TotpRecord | null> {
   return (await prisma.adminTotp.findUnique({
      where: { userId: adminId },
   })) as TotpRecord | null;
}

async function verifyTotpCode(
   record: TotpRecord,
   code: string
): Promise<boolean> {
   if (!/^\d{6}$/.test(code)) {
      return false;
   }

   const secret = decryptSecret(record.secretEnc, record.userId);
   const step = currentStep();

   for (const candidate of [step, step + TOTP_SKEW_STEPS, step - TOTP_SKEW_STEPS]) {
      if (record.lastUsedStep !== null && candidate <= record.lastUsedStep) {
         continue;
      }

      if (!codesEqual(totpCode(secret, candidate), code)) {
         continue;
      }

      const consumed = await prisma.adminTotp.updateMany({
         where: {
            userId: record.userId,
            OR: [
               { lastUsedStep: null },
               { lastUsedStep: { lt: candidate } },
            ],
         },
         data: { lastUsedStep: candidate },
      });

      return consumed.count === 1;
   }

   return false;
}

async function consumeRecoveryCode(
   record: TotpRecord,
   recoveryCode: string
): Promise<boolean> {
   const hash = hashRecoveryCode(recoveryCode);
   if (!record.recoveryHashes.includes(hash)) {
      return false;
   }

   const remainingHashes = record.recoveryHashes.filter(
      value => value !== hash
   );
   const consumed = await prisma.adminTotp.updateMany({
      where: {
         userId: record.userId,
         recoveryHashes: { has: hash },
         updatedAt: record.updatedAt,
      },
      data: { recoveryHashes: { set: remainingHashes } },
   });

   return consumed.count === 1;
}

export async function setupAdminTotp(
   adminId: string
): Promise<AdminTotpSetupResult> {
   const existing = await loadTotp(adminId);
   if (existing?.enabledAt) {
      throw new AdminTotpAlreadyEnabledError();
   }

   const secret = randomBytes(20);
   const secretBase32 = base32Encode(secret);
   const recoveryCodes = generateRecoveryCodes();
   const secretEnc = encryptSecret(secret, adminId);

   await prisma.adminTotp.upsert({
      where: { userId: adminId },
      create: {
         userId: adminId,
         secretEnc,
         enabledAt: null,
         recoveryHashes: recoveryCodes.map(hashRecoveryCode),
         lastUsedStep: null,
      },
      update: {
         secretEnc,
         enabledAt: null,
         recoveryHashes: recoveryCodes.map(hashRecoveryCode),
         lastUsedStep: null,
      },
   });

   return {
      otpauthUri: otpauthUri(adminId, secretBase32),
      recoveryCodes,
   };
}

export async function verifyAdminTotpSetup(
   adminId: string,
   code: string
): Promise<Date> {
   assertVerificationAllowed(adminId);

   const record = await loadTotp(adminId);
   if (!record) {
      throw new AdminTotpNotConfiguredError();
   }
   if (record.enabledAt) {
      throw new AdminTotpAlreadyEnabledError();
   }

   if (!(await verifyTotpCode(record, code))) {
      throw new AdminTotpInvalidCodeError();
   }

   const enabledAt = new Date();
   await prisma.adminTotp.update({
      where: { userId: adminId },
      data: { enabledAt },
   });
   clearVerificationAttempts(adminId);

   return enabledAt;
}

export async function loginWithAdminTotp(
   adminId: string,
   claims: AdminJwtPayload,
   input: AdminTotpLoginInput
): Promise<AdminTotpLoginResult> {
   assertVerificationAllowed(adminId);

   const record = await loadTotp(adminId);
   if (!record?.enabledAt) {
      throw new AdminTotpNotConfiguredError();
   }

   let verified = false;
   if (input.code) {
      verified = await verifyTotpCode(record, input.code);
   }
   if (!verified && input.recoveryCode) {
      verified = await consumeRecoveryCode(record, input.recoveryCode);
   }

   if (!verified) {
      throw new AdminTotpInvalidCodeError();
   }

   clearVerificationAttempts(adminId);

   return {
      accessToken: signAdminSessionToken(claims, 'verified'),
      tokenType: 'Bearer',
      expiresIn: envConfig.JWT_ACCESS_TOKEN_TTL_SECONDS,
   };
}
