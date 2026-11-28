import { createHmac } from 'crypto';
import jwt from 'jsonwebtoken';
import { envConfig } from '../../config';
import { prisma } from '../../utils/prisma.utils';
import {
   AdminTotpInvalidCodeError,
   AdminTotpRateLimitError,
   loginWithAdminTotp,
   resetAdminTotpRateLimit,
   setupAdminTotp,
   verifyAdminTotpSetup,
} from './admin-2fa.service';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      adminTotp: {
         findUnique: jest.fn(),
         upsert: jest.fn(),
         update: jest.fn(),
         updateMany: jest.fn(),
      },
   },
}));

const ADMIN_ID = 'admin-totp-test';
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const START_TIME = new Date('2026-11-23T00:00:00.000Z');

interface StoredTotp {
   userId: string;
   secretEnc: string;
   enabledAt: Date | null;
   recoveryHashes: string[];
   lastUsedStep: number | null;
   createdAt: Date;
   updatedAt: Date;
}

const adminTotp = prisma.adminTotp as unknown as {
   findUnique: jest.Mock;
   upsert: jest.Mock;
   update: jest.Mock;
   updateMany: jest.Mock;
};

let stored: StoredTotp | null = null;

function cloneStored(): StoredTotp | null {
   return stored
      ? {
           ...stored,
           recoveryHashes: [...stored.recoveryHashes],
           enabledAt: stored.enabledAt
              ? new Date(stored.enabledAt.getTime())
              : null,
        }
      : null;
}

function arraysEqual(left: string[], right: string[]): boolean {
   return (
      left.length === right.length &&
      left.every((value, index) => value === right[index])
   );
}

function base32Decode(value: string): Buffer {
   let bits = 0;
   let buffer = 0;
   const bytes: number[] = [];

   for (const character of value.toUpperCase().replace(/=+$/, '')) {
      const index = BASE32_ALPHABET.indexOf(character);
      if (index < 0) throw new Error(`Invalid base32 character: ${character}`);
      buffer = (buffer << 5) | index;
      bits += 5;
      if (bits >= 8) {
         bytes.push((buffer >>> (bits - 8)) & 0xff);
         bits -= 8;
      }
   }

   return Buffer.from(bytes);
}

function secretFromUri(uri: string): string {
   const secret = new URL(uri).searchParams.get('secret');
   if (!secret) throw new Error('otpauth URI is missing the secret');
   return secret;
}

function totpCode(uri: string, step: number): string {
   const counter = Buffer.alloc(8);
   counter.writeBigUInt64BE(BigInt(step));
   const digest = createHmac('sha1', base32Decode(secretFromUri(uri)))
      .update(counter)
      .digest();
   const offset = digest[digest.length - 1] & 0x0f;
   const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
   return value.toString().padStart(6, '0');
}

function stepNow(): number {
   return Math.floor(Date.now() / 1000 / 30);
}

function differentCode(uri: string, step: number): string {
   const valid = totpCode(uri, step);
   return valid === '000000' ? '000001' : '000000';
}

async function configureTotp(adminId = ADMIN_ID) {
   const setup = await setupAdminTotp(adminId);
   await verifyAdminTotpSetup(adminId, totpCode(setup.otpauthUri, stepNow()));
   return setup;
}

function pendingClaims(adminId = ADMIN_ID) {
   return {
      sub: adminId,
      adminId,
      role: 'admin',
      twoFactorStatus: 'pending_2fa' as const,
   };
}

beforeEach(() => {
   jest.useFakeTimers();
   jest.setSystemTime(START_TIME);
   stored = null;
   resetAdminTotpRateLimit();
   jest.clearAllMocks();

   adminTotp.findUnique.mockImplementation(async () => cloneStored());
   adminTotp.upsert.mockImplementation(async ({ create }) => {
      stored = { ...create, createdAt: START_TIME, updatedAt: START_TIME };
      return cloneStored();
   });
   adminTotp.update.mockImplementation(async ({ data }) => {
      stored = { ...stored!, ...data, updatedAt: new Date() };
      return cloneStored();
   });
   adminTotp.updateMany.mockImplementation(async ({ where, data }) => {
      if (!stored) return { count: 0 };

      if (where.recoveryHashes?.equals) {
         if (!arraysEqual(stored.recoveryHashes, where.recoveryHashes.equals)) {
            return { count: 0 };
         }
         stored.recoveryHashes = [...data.recoveryHashes.set];
      } else if (where.lastUsedStep !== undefined || where.OR) {
         const candidate = data.lastUsedStep as number;
         if (stored.lastUsedStep !== null && stored.lastUsedStep >= candidate) {
            return { count: 0 };
         }
         stored.lastUsedStep = candidate;
      } else {
         return { count: 0 };
      }

      stored.updatedAt = new Date();
      return { count: 1 };
   });
});

afterEach(() => {
   jest.useRealTimers();
});

describe('admin TOTP setup', () => {
   it('returns an otpauth URI and stores an encrypted secret with hashed recovery codes', async () => {
      const result = await setupAdminTotp(ADMIN_ID);
      const uri = new URL(result.otpauthUri);
      const secret = secretFromUri(result.otpauthUri);

      expect(uri.protocol).toBe('otpauth:');
      expect(uri.hostname).toBe('totp');
      expect(uri.searchParams.get('secret')).toBe(secret);
      expect(uri.searchParams.get('algorithm')).toBe('SHA1');
      expect(uri.searchParams.get('digits')).toBe('6');
      expect(uri.searchParams.get('period')).toBe('30');

      expect(result.recoveryCodes).toHaveLength(10);
      expect(new Set(result.recoveryCodes).size).toBe(10);
      result.recoveryCodes.forEach(code => {
         expect(code).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{2}$/);
      });

      expect(stored).not.toBeNull();
      expect(stored!.secretEnc).toMatch(/^v1\./);
      expect(stored!.secretEnc).not.toContain(secret);
      expect(stored!.enabledAt).toBeNull();
      expect(stored!.recoveryHashes).toHaveLength(10);
      stored!.recoveryHashes.forEach(hash => expect(hash).toMatch(/^[0-9a-f]{64}$/));
      result.recoveryCodes.forEach(code => {
         expect(stored!.recoveryHashes).not.toContain(code);
         expect(stored!.recoveryHashes).not.toContain(code.replace(/-/g, ''));
      });
   });

   it('enables TOTP only with a valid code', async () => {
      const setup = await setupAdminTotp(ADMIN_ID);
      const step = stepNow();

      await expect(
         verifyAdminTotpSetup(ADMIN_ID, differentCode(setup.otpauthUri, step))
      ).rejects.toBeInstanceOf(AdminTotpInvalidCodeError);
      expect(stored!.enabledAt).toBeNull();

      resetAdminTotpRateLimit(ADMIN_ID);
      const enabledAt = await verifyAdminTotpSetup(
         ADMIN_ID,
         totpCode(setup.otpauthUri, step)
      );

      expect(enabledAt).toBeInstanceOf(Date);
      expect(stored!.enabledAt).toEqual(enabledAt);
   });
});

describe('admin TOTP login', () => {
   it('issues a verified session for a valid code and rejects an invalid code', async () => {
      const setup = await configureTotp();
      jest.setSystemTime(new Date(START_TIME.getTime() + 30_000));
      const step = stepNow();

      await expect(
         loginWithAdminTotp(ADMIN_ID, pendingClaims(), {
            code: differentCode(setup.otpauthUri, step),
         })
      ).rejects.toBeInstanceOf(AdminTotpInvalidCodeError);

      const result = await loginWithAdminTotp(ADMIN_ID, pendingClaims(), {
         code: totpCode(setup.otpauthUri, step),
      });
      const decoded = jwt.verify(result.accessToken, envConfig.JWT_SECRET) as jwt.JwtPayload;

      expect(result.tokenType).toBe('Bearer');
      expect(result.expiresIn).toBe(envConfig.JWT_ACCESS_TOKEN_TTL_SECONDS);
      expect(decoded).toMatchObject({
         adminId: ADMIN_ID,
         sub: ADMIN_ID,
         role: 'admin',
         twoFactorStatus: 'verified',
      });
   });

   it('rejects a code that was already used in the same step', async () => {
      const setup = await configureTotp();
      jest.setSystemTime(new Date(START_TIME.getTime() + 30_000));
      const code = totpCode(setup.otpauthUri, stepNow());

      await loginWithAdminTotp(ADMIN_ID, pendingClaims(), { code });

      await expect(
         loginWithAdminTotp(ADMIN_ID, pendingClaims(), { code })
      ).rejects.toBeInstanceOf(AdminTotpInvalidCodeError);
   });

   it('rejects a code consumed during setup when logging in during the same step', async () => {
      const setup = await setupAdminTotp(ADMIN_ID);
      const code = totpCode(setup.otpauthUri, stepNow());
      await verifyAdminTotpSetup(ADMIN_ID, code);

      await expect(
         loginWithAdminTotp(ADMIN_ID, pendingClaims(), { code })
      ).rejects.toBeInstanceOf(AdminTotpInvalidCodeError);
   });

   it('accepts one step of clock skew in either direction but not two', async () => {
      const previousStep = await setupAdminTotp('admin-skew-behind');
      await verifyAdminTotpSetup(
         'admin-skew-behind',
         totpCode(previousStep.otpauthUri, stepNow() - 1)
      );
      expect(stored!.enabledAt).toBeInstanceOf(Date);

      stored = null;
      const aheadStep = await setupAdminTotp('admin-skew-ahead');
      await verifyAdminTotpSetup(
         'admin-skew-ahead',
         totpCode(aheadStep.otpauthUri, stepNow() + 1)
      );
      expect(stored!.enabledAt).toBeInstanceOf(Date);

      stored = null;
      const tooOld = await setupAdminTotp('admin-skew-too-old');
      await expect(
         verifyAdminTotpSetup(
            'admin-skew-too-old',
            totpCode(tooOld.otpauthUri, stepNow() - 2)
         )
      ).rejects.toBeInstanceOf(AdminTotpInvalidCodeError);
   });
});

describe('admin TOTP recovery codes', () => {
   it('consumes a recovery code once', async () => {
      const setup = await configureTotp();
      jest.setSystemTime(new Date(START_TIME.getTime() + 30_000));
      const recoveryCode = setup.recoveryCodes[0];

      const result = await loginWithAdminTotp(ADMIN_ID, pendingClaims(), {
         recoveryCode: recoveryCode.toLowerCase().replace(/-/g, ' '),
      });
      expect(result.accessToken).toEqual(expect.any(String));
      expect(stored!.recoveryHashes).toHaveLength(9);

      await expect(
         loginWithAdminTotp(ADMIN_ID, pendingClaims(), {
            recoveryCode,
         })
      ).rejects.toBeInstanceOf(AdminTotpInvalidCodeError);
      expect(stored!.recoveryHashes).toHaveLength(9);
   });

   it('allows only one concurrent use of the same recovery code', async () => {
      const setup = await configureTotp();
      jest.setSystemTime(new Date(START_TIME.getTime() + 30_000));
      const recoveryCode = setup.recoveryCodes[1];

      const results = await Promise.allSettled([
         loginWithAdminTotp(ADMIN_ID, pendingClaims(), { recoveryCode }),
         loginWithAdminTotp(ADMIN_ID, pendingClaims(), { recoveryCode }),
      ]);

      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
      expect(stored!.recoveryHashes).toHaveLength(9);
   });
});

describe('admin TOTP verification rate limit', () => {
   it('returns 429 on the sixth failed attempt within 15 minutes', async () => {
      const setup = await setupAdminTotp(ADMIN_ID);
      const invalidCode = differentCode(setup.otpauthUri, stepNow());

      for (let attempt = 0; attempt < 5; attempt++) {
         await expect(
            verifyAdminTotpSetup(ADMIN_ID, invalidCode)
         ).rejects.toBeInstanceOf(AdminTotpInvalidCodeError);
      }

      const rateLimitError = (await verifyAdminTotpSetup(
         ADMIN_ID,
         invalidCode
      ).catch(error => error)) as AdminTotpRateLimitError;

      expect(rateLimitError).toBeInstanceOf(AdminTotpRateLimitError);
      expect(rateLimitError.statusCode).toBe(429);
      expect(rateLimitError.retryAfterSeconds).toBeGreaterThan(0);

      jest.setSystemTime(new Date(START_TIME.getTime() + 15 * 60 * 1000 + 1));
      await expect(
         verifyAdminTotpSetup(ADMIN_ID, invalidCode)
      ).rejects.toBeInstanceOf(AdminTotpInvalidCodeError);
   });
});
