import crypto from 'crypto';

const SIGNATURE_HEADER_PATTERN = /^sha256=([0-9a-f]+)$/i;

/**
 * Verifies an incoming webhook's `sha256=<hex>` HMAC signature header against
 * the raw request payload using a constant-time comparison.
 */
export function verifyWebhookSignature(
   payload: Buffer,
   header: string,
   secret: string
): boolean {
   if (!header) return false;

   const match = SIGNATURE_HEADER_PATTERN.exec(header.trim());
   if (!match) return false;

   const providedSignature = match[1];
   const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');

   const providedBuffer = Buffer.from(providedSignature, 'utf8');
   const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

   if (providedBuffer.length !== expectedBuffer.length) {
      return false;
   }

   return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}
