// src/modules/auth/passkey.service.ts
// WebAuthn passkey registration, authentication, and embedded wallet custody (#1313).

import crypto from 'crypto';
import {
   generateRegistrationOptions,
   verifyRegistrationResponse,
   generateAuthenticationOptions,
   verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
   RegistrationResponseJSON,
   AuthenticationResponseJSON,
   AuthenticatorTransportFuture,
} from '@simplewebauthn/server';
import { Keypair, Networks, TransactionBuilder } from '@stellar/stellar-base';
import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
} from '../../utils/redis.utils';
import { signWalletAccessToken } from '../../utils/jwt.utils';
import { SendMail } from '../../utils/mail.utils';
import { envConfig } from '../../config';
import { logger } from '../../utils/logger.utils';
import {
   encryptWalletSecret,
   decryptWalletSecret,
} from './embedded-wallet.crypto';

export const PASSKEY_CHALLENGE_TTL_SECONDS = 300; // 5 minutes
export const DEFAULT_SIGN_THRESHOLD_AMOUNT = 100;
export const DEFAULT_RECENT_ASSERTION_TTL_SECONDS = 300; // 5 minutes
export const DEFAULT_FRESH_ASSERTION_TTL_SECONDS = 60; // 1 minute
export const EXPORT_EMAIL_CODE_TTL_SECONDS = 600; // 10 minutes

const REGISTER_CHALLENGE_PREFIX = 'passkey:challenge:register:';
const LOGIN_CHALLENGE_PREFIX = 'passkey:challenge:login:';
const EXPORT_EMAIL_PREFIX = 'embedded-wallet:export-email:';

interface StoredChallenge {
   challenge: string;
   userId?: string;
   email?: string;
   expectedOrigin: string;
   expectedRPID: string;
   createdAt: number;
}

interface StoredEmailConfirmation {
   codeHash: string;
   userId: string;
   expiresAt: number;
}

export class PasskeyServiceError extends Error {
   statusCode: number;
   code: string;

   constructor(statusCode: number, code: string, message: string) {
      super(message);
      this.name = 'PasskeyServiceError';
      this.statusCode = statusCode;
      this.code = code;
   }
}

function getRpConfig(originOverride?: string): {
   rpID: string;
   rpName: string;
   origin: string;
} {
   const rpID = process.env.WEBAUTHN_RP_ID ?? 'localhost';
   const rpName = process.env.WEBAUTHN_RP_NAME ?? 'AccessLayer';
   const origin =
      originOverride ??
      process.env.WEBAUTHN_ORIGIN ??
      envConfig.FRONTEND_URL ??
      `https://${rpID}`;
   return { rpID, rpName, origin };
}

function getAllowedOrigins(): string[] {
   const configured = process.env.WEBAUTHN_ALLOWED_ORIGINS;
   if (configured) {
      return configured
         .split(',')
         .map(o => o.trim())
         .filter(Boolean);
   }
   return [getRpConfig().origin];
}

function getSignThresholdAmount(): number {
   const raw = process.env.EMBEDDED_WALLET_SIGN_THRESHOLD_AMOUNT;
   if (!raw) return DEFAULT_SIGN_THRESHOLD_AMOUNT;
   const parsed = Number(raw);
   return Number.isFinite(parsed) && parsed >= 0
      ? parsed
      : DEFAULT_SIGN_THRESHOLD_AMOUNT;
}

function getRecentAssertionTtlMs(): number {
   const raw = process.env.EMBEDDED_WALLET_ASSERTION_TTL_SECONDS;
   const secs = raw ? Number(raw) : DEFAULT_RECENT_ASSERTION_TTL_SECONDS;
   return (Number.isFinite(secs) && secs > 0 ? secs : DEFAULT_RECENT_ASSERTION_TTL_SECONDS) * 1000;
}

function getFreshAssertionTtlMs(): number {
   const raw = process.env.EMBEDDED_WALLET_FRESH_ASSERTION_TTL_SECONDS;
   const secs = raw ? Number(raw) : DEFAULT_FRESH_ASSERTION_TTL_SECONDS;
   return (Number.isFinite(secs) && secs > 0 ? secs : DEFAULT_FRESH_ASSERTION_TTL_SECONDS) * 1000;
}

function networkPassphrase(): string {
   return envConfig.STELLAR_NETWORK === 'mainnet'
      ? Networks.PUBLIC
      : Networks.TESTNET;
}

function hashConfirmationCode(code: string): string {
   return crypto.createHash('sha256').update(code).digest('hex');
}

/**
 * Generates WebAuthn registration options and stores the challenge in Redis for 5 minutes.
 */
export async function createPasskeyRegistrationOptions(input: {
   userId: string;
   email: string;
   displayName?: string;
   origin?: string;
}) {
   const { rpID, rpName, origin } = getRpConfig(input.origin);
   const existingCreds = await prisma.passkeyCredential.findMany({
      where: { userId: input.userId },
      select: { credentialId: true, transports: true },
   });

   const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: input.email,
      userDisplayName: input.displayName ?? input.email,
      attestationType: 'none',
      excludeCredentials: existingCreds.map(c => ({
         id: c.credentialId,
         transports: c.transports as AuthenticatorTransportFuture[],
      })),
      authenticatorSelection: {
         residentKey: 'preferred',
         userVerification: 'preferred',
      },
   });

   const challengeKey = `${REGISTER_CHALLENGE_PREFIX}${input.userId}`;
   const stored: StoredChallenge = {
      challenge: options.challenge,
      userId: input.userId,
      email: input.email,
      expectedOrigin: origin,
      expectedRPID: rpID,
      createdAt: Date.now(),
   };
   await cacheSetJson(challengeKey, stored, PASSKEY_CHALLENGE_TTL_SECONDS);

   return {
      options,
      challengeId: input.userId,
   };
}

/**
 * Verifies a WebAuthn registration response, stores the credential, provisions
 * an encrypted embedded Stellar wallet if one does not exist, and returns an access token.
 */
export async function verifyPasskeyRegistration(input: {
   userId: string;
   response: RegistrationResponseJSON;
   origin?: string;
}) {
   const challengeKey = `${REGISTER_CHALLENGE_PREFIX}${input.userId}`;
   const stored = await cacheGetJson<StoredChallenge>(challengeKey);
   if (!stored) {
      throw new PasskeyServiceError(
         400,
         'CHALLENGE_EXPIRED',
         'Registration challenge missing or expired'
      );
   }

   const expectedOrigin = input.origin ?? stored.expectedOrigin;
   const allowedOrigins = getAllowedOrigins();
   if (input.origin && !allowedOrigins.includes(input.origin) && input.origin !== stored.expectedOrigin) {
      throw new PasskeyServiceError(
         403,
         'INVALID_ORIGIN',
         'Origin is not allowed for WebAuthn registration'
      );
   }

   const verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: stored.challenge,
      expectedOrigin,
      expectedRPID: stored.expectedRPID,
   });

   await cacheInvalidate(challengeKey);

   if (!verification.verified || !verification.registrationInfo) {
      throw new PasskeyServiceError(
         400,
         'PASSKEY_VERIFICATION_FAILED',
         'Passkey registration verification failed'
      );
   }

   const { credential, credentialDeviceType, credentialBackedUp } =
      verification.registrationInfo;

   const publicKeyBase64Url = Buffer.from(credential.publicKey).toString('base64url');
   const now = new Date();

   await prisma.passkeyCredential.create({
      data: {
         userId: input.userId,
         credentialId: credential.id,
         publicKey: publicKeyBase64Url,
         counter: credential.counter,
         transports: (input.response.response.transports ?? []) as string[],
         deviceType: credentialDeviceType,
         backedUp: credentialBackedUp,
         lastAssertedAt: now,
      },
   });

   let wallet = await prisma.embeddedWallet.findUnique({
      where: { userId: input.userId },
      select: { id: true, userId: true, publicKey: true, createdAt: true },
   });

   if (!wallet) {
      const keypair = Keypair.random();
      const encryptedSecret = await encryptWalletSecret(keypair.secret());
      wallet = await prisma.embeddedWallet.create({
         data: {
            userId: input.userId,
            publicKey: keypair.publicKey(),
            encryptedSecret,
            keyVersion: 'v1',
         },
         select: { id: true, userId: true, publicKey: true, createdAt: true },
      });
   }

   const accessToken = signWalletAccessToken(wallet.publicKey, input.userId);

   logger.info(
      { userId: input.userId, publicKey: wallet.publicKey },
      'Passkey registered and embedded wallet provisioned'
   );

   return {
      verified: true,
      credentialId: credential.id,
      wallet: {
         id: wallet.id,
         publicKey: wallet.publicKey,
      },
      accessToken,
   };
}

/**
 * Generates WebAuthn login/authentication options and stores the challenge in Redis for 5 minutes.
 */
export async function createPasskeyLoginOptions(input: {
   userId?: string;
   origin?: string;
}) {
   const { rpID, origin } = getRpConfig(input.origin);
   const allowCredentials = input.userId
      ? (
           await prisma.passkeyCredential.findMany({
              where: { userId: input.userId },
              select: { credentialId: true, transports: true },
           })
        ).map(c => ({
           id: c.credentialId,
           transports: c.transports as AuthenticatorTransportFuture[],
        }))
      : undefined;

   const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials,
      userVerification: 'preferred',
   });

   const challengeId = crypto.randomUUID();
   const challengeKey = `${LOGIN_CHALLENGE_PREFIX}${challengeId}`;
   const stored: StoredChallenge = {
      challenge: options.challenge,
      userId: input.userId,
      expectedOrigin: origin,
      expectedRPID: rpID,
      createdAt: Date.now(),
   };
   await cacheSetJson(challengeKey, stored, PASSKEY_CHALLENGE_TTL_SECONDS);

   return {
      options,
      challengeId,
   };
}

/**
 * Verifies a WebAuthn login assertion, validating signature counter and origin.
 */
export async function verifyPasskeyLogin(input: {
   challengeId: string;
   response: AuthenticationResponseJSON;
   origin?: string;
}) {
   const challengeKey = `${LOGIN_CHALLENGE_PREFIX}${input.challengeId}`;
   const stored = await cacheGetJson<StoredChallenge>(challengeKey);
   if (!stored) {
      throw new PasskeyServiceError(
         400,
         'CHALLENGE_EXPIRED',
         'Authentication challenge missing or expired'
      );
   }

   const credential = await prisma.passkeyCredential.findUnique({
      where: { credentialId: input.response.id },
   });
   if (!credential) {
      throw new PasskeyServiceError(
         401,
         'CREDENTIAL_NOT_FOUND',
         'Passkey credential not recognized'
      );
   }

   if (stored.userId && credential.userId !== stored.userId) {
      throw new PasskeyServiceError(
         403,
         'CREDENTIAL_MISMATCH',
         'Credential does not belong to requested user'
      );
   }

   const requestOrigin = input.origin ?? stored.expectedOrigin;
   const allowedOrigins = getAllowedOrigins();
   if (
      requestOrigin !== stored.expectedOrigin &&
      !allowedOrigins.includes(requestOrigin)
   ) {
      throw new PasskeyServiceError(
         403,
         'INVALID_ORIGIN',
         'Origin validation failed for WebAuthn assertion'
      );
   }

   const verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: stored.challenge,
      expectedOrigin: requestOrigin,
      expectedRPID: stored.expectedRPID,
      credential: {
         id: credential.credentialId,
         publicKey: new Uint8Array(Buffer.from(credential.publicKey, 'base64url')),
         counter: credential.counter,
         transports: credential.transports as AuthenticatorTransportFuture[],
      },
   });

   await cacheInvalidate(challengeKey);

   if (!verification.verified) {
      throw new PasskeyServiceError(
         401,
         'PASSKEY_VERIFICATION_FAILED',
         'Passkey assertion verification failed'
      );
   }

   const newCounter = verification.authenticationInfo.newCounter;
   if (
      (credential.counter > 0 || newCounter > 0) &&
      newCounter <= credential.counter
   ) {
      throw new PasskeyServiceError(
         401,
         'COUNTER_REPLAY_DETECTED',
         'Signature counter did not advance; possible cloned authenticator'
      );
   }

   await prisma.passkeyCredential.update({
      where: { id: credential.id },
      data: {
         counter: newCounter,
         lastAssertedAt: new Date(),
      },
   });

   const wallet = await prisma.embeddedWallet.findUnique({
      where: { userId: credential.userId },
      select: { id: true, userId: true, publicKey: true },
   });
   if (!wallet) {
      throw new PasskeyServiceError(
         404,
         'EMBEDDED_WALLET_NOT_FOUND',
         'Embedded wallet not found for user'
      );
   }

   const accessToken = signWalletAccessToken(wallet.publicKey, credential.userId);

   return {
      verified: true,
      userId: credential.userId,
      wallet: {
         id: wallet.id,
         publicKey: wallet.publicKey,
      },
      accessToken,
   };
}

async function resolveUserIdFromWallet(walletAddress: string): Promise<string> {
   const wallet = await prisma.embeddedWallet.findUnique({
      where: { publicKey: walletAddress },
      select: { userId: true },
   });
   if (!wallet) {
      throw new PasskeyServiceError(
         404,
         'EMBEDDED_WALLET_NOT_FOUND',
         'Embedded wallet not found'
      );
   }
   return wallet.userId;
}

async function hasAssertionWithinWindow(
   userId: string,
   windowMs: number
): Promise<boolean> {
   const cutoff = new Date(Date.now() - windowMs);
   const recent = await prisma.passkeyCredential.findFirst({
      where: {
         userId,
         lastAssertedAt: { gte: cutoff },
      },
      orderBy: { lastAssertedAt: 'desc' },
      select: { id: true },
   });
   return Boolean(recent);
}

/**
 * Signs a Stellar transaction using the user's embedded wallet.
 * Requires a recent passkey assertion when `amount` exceeds the configured threshold.
 */
export async function signWithEmbeddedWallet(input: {
   walletAddress: string;
   transactionXdr: string;
   amount: number;
   assertionChallengeId?: string;
   assertionResponse?: AuthenticationResponseJSON;
   origin?: string;
}) {
   const wallet = await prisma.embeddedWallet.findUnique({
      where: { publicKey: input.walletAddress },
   });
   if (!wallet) {
      throw new PasskeyServiceError(
         404,
         'EMBEDDED_WALLET_NOT_FOUND',
         'Embedded wallet not found'
      );
   }

   const threshold = getSignThresholdAmount();
   if (input.amount > threshold) {
      if (input.assertionChallengeId && input.assertionResponse) {
         await verifyPasskeyLogin({
            challengeId: input.assertionChallengeId,
            response: input.assertionResponse,
            origin: input.origin,
         });
      } else {
         const recent = await hasAssertionWithinWindow(
            wallet.userId,
            getRecentAssertionTtlMs()
         );
         if (!recent) {
            throw new PasskeyServiceError(
               403,
               'PASSKEY_ASSERTION_REQUIRED',
               `Transactions above ${threshold} require a recent passkey assertion`
            );
         }
      }
   }

   const secret = await decryptWalletSecret(wallet.encryptedSecret);
   const keypair = Keypair.fromSecret(secret);
   const tx = TransactionBuilder.fromXDR(
      input.transactionXdr,
      networkPassphrase()
   );
   tx.sign(keypair);

   logger.info(
      { publicKey: wallet.publicKey, amount: input.amount },
      'Embedded wallet signed transaction'
   );

   return {
      publicKey: wallet.publicKey,
      signedXdr: tx.toXDR(),
   };
}

/**
 * Sends a 6-digit email confirmation code required before exporting an embedded wallet.
 */
export async function requestEmbeddedWalletExportConfirmation(input: {
   walletAddress: string;
}) {
   const userId = await resolveUserIdFromWallet(input.walletAddress);
   const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
   });
   if (!user?.email) {
      throw new PasskeyServiceError(
         400,
         'EMAIL_REQUIRED',
         'A verified user email is required to export an embedded wallet'
      );
   }

   const code = crypto.randomInt(100000, 999999).toString();
   const key = `${EXPORT_EMAIL_PREFIX}${userId}`;
   const payload: StoredEmailConfirmation = {
      codeHash: hashConfirmationCode(code),
      userId,
      expiresAt: Date.now() + EXPORT_EMAIL_CODE_TTL_SECONDS * 1000,
   };
   await cacheSetJson(key, payload, EXPORT_EMAIL_CODE_TTL_SECONDS);

   await SendMail({
      to: user.email,
      subject: 'AccessLayer Embedded Wallet Export Confirmation',
      html: `<p>Your wallet export confirmation code is: <strong>${code}</strong></p><p>It expires in 10 minutes.</p>`,
   });

   return { sent: true };
}

/**
 * Exports the decrypted embedded wallet secret after validating both a fresh
 * passkey assertion and an email confirmation code.
 */
export async function exportEmbeddedWallet(input: {
   walletAddress: string;
   emailConfirmationCode: string;
   assertionChallengeId?: string;
   assertionResponse?: AuthenticationResponseJSON;
   origin?: string;
}) {
   const wallet = await prisma.embeddedWallet.findUnique({
      where: { publicKey: input.walletAddress },
   });
   if (!wallet) {
      throw new PasskeyServiceError(
         404,
         'EMBEDDED_WALLET_NOT_FOUND',
         'Embedded wallet not found'
      );
   }

   if (input.assertionChallengeId && input.assertionResponse) {
      await verifyPasskeyLogin({
         challengeId: input.assertionChallengeId,
         response: input.assertionResponse,
         origin: input.origin,
      });
   } else {
      const fresh = await hasAssertionWithinWindow(
         wallet.userId,
         getFreshAssertionTtlMs()
      );
      if (!fresh) {
         throw new PasskeyServiceError(
            403,
            'FRESH_ASSERTION_REQUIRED',
            'Wallet export requires a fresh passkey assertion'
         );
      }
   }

   const emailKey = `${EXPORT_EMAIL_PREFIX}${wallet.userId}`;
   const storedEmail = await cacheGetJson<StoredEmailConfirmation>(emailKey);
   if (
      !storedEmail ||
      storedEmail.expiresAt < Date.now() ||
      storedEmail.codeHash !== hashConfirmationCode(input.emailConfirmationCode)
   ) {
      throw new PasskeyServiceError(
         403,
         'EMAIL_CONFIRMATION_INVALID',
         'Invalid or expired email confirmation code'
      );
   }

   await cacheInvalidate(emailKey);

   const secretKey = await decryptWalletSecret(wallet.encryptedSecret);

   logger.info(
      { userId: wallet.userId, publicKey: wallet.publicKey },
      'Embedded wallet exported after fresh assertion and email confirmation'
   );

   return {
      publicKey: wallet.publicKey,
      secretKey,
   };
}
