// src/modules/auth/embedded-wallet.crypto.ts
// AES-256-GCM encryption boundary for embedded wallet secrets (#1313).
// Keys are retrieved from the configured secrets manager / environment and
// wallet secrets are never logged or serialized.

import crypto from 'crypto';
import { envConfig } from '../../config';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const KEY_VERSION = 'v1';

export interface SecretsManagerProvider {
   getWalletMasterKey(version?: string): Promise<string> | string;
}

const defaultSecretsProvider: SecretsManagerProvider = {
   getWalletMasterKey(): string {
      const secret =
         process.env.SECRETS_MANAGER_WALLET_KEY ??
         process.env.EMBEDDED_WALLET_ENCRYPTION_KEY ??
         envConfig.APP_SECRET;
      if (!secret) {
         throw new Error('Embedded wallet master key is not configured in secrets manager');
      }
      return secret;
   },
};

let activeSecretsProvider: SecretsManagerProvider = defaultSecretsProvider;

/**
 * Allows injecting a custom secrets manager provider (e.g. AWS/GCP Secrets Manager
 * or a deterministic test stub).
 */
export function setSecretsManagerProvider(
   provider: SecretsManagerProvider | null
): void {
   activeSecretsProvider = provider ?? defaultSecretsProvider;
}

async function deriveAesKey(version = KEY_VERSION): Promise<Buffer> {
   const masterSecret = await activeSecretsProvider.getWalletMasterKey(version);
   if (!masterSecret || masterSecret.length < 16) {
      throw new Error('Embedded wallet master key from secrets manager is invalid');
   }
   return crypto.createHash('sha256').update(masterSecret).digest();
}

/**
 * Encrypts a Stellar secret seed with AES-256-GCM using the key from the
 * secrets manager.
 */
export async function encryptWalletSecret(
   plaintextSecret: string,
   version = KEY_VERSION
): Promise<string> {
   const key = await deriveAesKey(version);
   const iv = crypto.randomBytes(IV_LENGTH);
   const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
   const encrypted = Buffer.concat([
      cipher.update(plaintextSecret, 'utf8'),
      cipher.final(),
   ]);
   const authTag = cipher.getAuthTag();
   return `${version}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a stored AES-256-GCM encrypted wallet secret.
 */
export async function decryptWalletSecret(ciphertext: string): Promise<string> {
   const parts = ciphertext.split(':');
   if (parts.length !== 4 || !parts[0]) {
      throw new Error('Unsupported encrypted wallet secret format');
   }
   const [version, ivHex, authTagHex, encryptedHex] = parts;
   const key = await deriveAesKey(version);
   const iv = Buffer.from(ivHex, 'hex');
   const authTag = Buffer.from(authTagHex, 'hex');
   const encrypted = Buffer.from(encryptedHex, 'hex');

   const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
   decipher.setAuthTag(authTag);
   const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
   ]);
   return decrypted.toString('utf8');
}
