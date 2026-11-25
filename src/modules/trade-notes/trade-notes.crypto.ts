import crypto from 'crypto';
import { envConfig } from '../../config';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const PREFIX = 'v1';

function deriveEncryptionKey(secretOverride?: string): Buffer {
   const secret =
      secretOverride ??
      process.env.TRADE_NOTE_ENCRYPTION_KEY ??
      envConfig.APP_SECRET;
   return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypts a trade note body with AES-256-GCM so note contents remain
 * confidential at rest.
 */
export function encryptNoteBody(
   plaintext: string,
   secretOverride?: string
): string {
   const key = deriveEncryptionKey(secretOverride);
   const iv = crypto.randomBytes(IV_LENGTH);
   const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
   const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
   ]);
   const authTag = cipher.getAuthTag();
   return `${PREFIX}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a stored AES-256-GCM trade note body.
 */
export function decryptNoteBody(
   ciphertext: string,
   secretOverride?: string
): string {
   const parts = ciphertext.split(':');
   if (parts.length !== 4 || parts[0] !== PREFIX) {
      throw new Error('Unsupported encrypted trade note format');
   }
   const [, ivHex, authTagHex, encryptedHex] = parts;
   const key = deriveEncryptionKey(secretOverride);
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
