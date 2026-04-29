import crypto from 'crypto';
import { Buffer } from 'node:buffer';
import { envConfig } from '../config';

/**
 * Custom error class thrown when cursor validation fails.
 */
export class CursorChecksumError extends Error {
   constructor(message: string = 'Invalid or tampered cursor checksum') {
      super(message);
      this.name = 'CursorChecksumError';
   }
}

/**
 * Generates an HMAC SHA-256 checksum for the given string payload.
 *
 * @param payload - The data string to checksum
 * @returns A hex string representing the checksum
 */
export function generateCursorChecksum(payload: string): string {
   const secret = envConfig.APP_SECRET;
   return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Encodes an object payload into a base64url string with an appended HMAC checksum.
 * Format: `base64url(payload).checksum`
 *
 * @param payload - The object or string to encode into a cursor
 * @returns The signed cursor string
 */
export function encodeCursor<T>(payload: T): string {
   const payloadStr = JSON.stringify(payload);
   const base64Payload = Buffer.from(payloadStr).toString('base64url');
   const checksum = generateCursorChecksum(base64Payload);
   
   return `${base64Payload}.${checksum}`;
}

/**
 * Decodes a cursor string, verifying its integrity via the appended checksum.
 *
 * @param cursor - The signed cursor string (e.g. `base64url.checksum`)
 * @returns The decoded payload object
 * @throws {CursorChecksumError} If the checksum is missing or invalid
 */
export function decodeCursor<T>(cursor: string): T {
   if (!cursor || typeof cursor !== 'string') {
      throw new CursorChecksumError('Cursor must be a provided string');
   }

   const parts = cursor.split('.');
   if (parts.length > 2) {
      throw new CursorChecksumError('Invalid cursor format. Expected base64payload.checksum');
   }

   const [base64Payload, providedChecksum] = parts;
   
   if (!base64Payload) {
      throw new CursorChecksumError('Cursor payload cannot be empty');
   }
   
   // Backward compatibility: allow parsing without checksum if no dot was present
   if (providedChecksum !== undefined) {
      if (!providedChecksum) {
         throw new CursorChecksumError('Cursor checksum cannot be empty if signature separator is present');
      }

      const expectedChecksum = generateCursorChecksum(base64Payload);
      
      // Use timing-safe equal to prevent timing attacks comparing checksums
      let expectedBuffer: Buffer;
      let providedBuffer: Buffer;
      
      try {
         expectedBuffer = Buffer.from(expectedChecksum, 'hex');
         providedBuffer = Buffer.from(providedChecksum, 'hex');
      } catch {
         throw new CursorChecksumError('Invalid checksum format');
      }
      
      if (
         expectedBuffer.length !== providedBuffer.length ||
         !crypto.timingSafeEqual(expectedBuffer, providedBuffer)
      ) {
         throw new CursorChecksumError('Cursor checksum mismatch');
      }
   }

   let payloadStr: string;
   try {
      payloadStr = Buffer.from(base64Payload, 'base64url').toString('utf8');
   } catch {
      throw new CursorChecksumError('Failed to decode base64 payload');
   }
   
   try {
      return JSON.parse(payloadStr) as T;
   } catch {
      throw new CursorChecksumError('Failed to parse cursor JSON payload');
   }
}
