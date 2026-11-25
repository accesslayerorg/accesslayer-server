// src/modules/notifications/notification-preference.tokens.test.ts
// Unit tests for notification preference verification and unsubscribe tokens (#1217).

import {
   createVerificationToken,
   verifyVerificationToken,
   createUnsubscribeToken,
   verifyUnsubscribeToken,
   VERIFICATION_TOKEN_TTL_MS,
   TOKEN_PURPOSES,
} from './notification-preference.tokens';

describe('Notification Preference Tokens', () => {
   const wallet = 'GB5WOC7XCYDEVMQFWVSISD6O5L6RBGV54TGNJ2753T5N7B2W5YVMR6W7';
   const email = 'alice@example.com';
   const fixedNow = 1_700_000_000_000; // Fixed timestamp

   describe('Verification Token', () => {
      it('creates and verifies a valid verification token', () => {
         const token = createVerificationToken(wallet, email, fixedNow);
         const decoded = verifyVerificationToken(token, fixedNow + 1000);

         expect(decoded.wallet).toBe(wallet);
         expect(decoded.email).toBe(email);
      });

      it('normalizes email to lowercase and trims wallet whitespace', () => {
         const token = createVerificationToken(`  ${wallet}  `, '  ALICE@EXAMPLE.COM  ', fixedNow);
         const decoded = verifyVerificationToken(token, fixedNow);

         expect(decoded.wallet).toBe(wallet);
         expect(decoded.email).toBe('alice@example.com');
      });

      it('strictly enforces 24-hour expiration boundary', () => {
         const token = createVerificationToken(wallet, email, fixedNow);

         // Just before 24 hours: valid
         const validTime = fixedNow + VERIFICATION_TOKEN_TTL_MS - 1000;
         expect(() => verifyVerificationToken(token, validTime)).not.toThrow();

         // Exactly at 24 hours: expired
         const expiredBoundary = fixedNow + VERIFICATION_TOKEN_TTL_MS;
         expect(() => verifyVerificationToken(token, expiredBoundary)).toThrow(
            expect.objectContaining({ code: 'EXPIRED_TOKEN' })
         );

         // Past 24 hours: expired
         const pastTime = fixedNow + VERIFICATION_TOKEN_TTL_MS + 60_000;
         expect(() => verifyVerificationToken(token, pastTime)).toThrow(
            expect.objectContaining({ code: 'EXPIRED_TOKEN' })
         );
      });

      it('rejects tampered token signature', () => {
         const token = createVerificationToken(wallet, email, fixedNow);
         const [data, sig] = token.split('.');
         const tamperedSig = sig.slice(0, -3) + 'abc';
         const tamperedToken = `${data}.${tamperedSig}`;

         expect(() => verifyVerificationToken(tamperedToken, fixedNow)).toThrow(
            expect.objectContaining({ code: 'INVALID_SIGNATURE' })
         );
      });

      it('rejects tampered token payload data', () => {
         const token = createVerificationToken(wallet, email, fixedNow);
         const [, sig] = token.split('.');
         const tamperedPayload = Buffer.from(
            JSON.stringify({
               wallet,
               email: 'hacker@example.com',
               purpose: TOKEN_PURPOSES.VERIFY_EMAIL,
               exp: fixedNow + 100_000,
            })
         ).toString('base64url');
         const tamperedToken = `${tamperedPayload}.${sig}`;

         expect(() => verifyVerificationToken(tamperedToken, fixedNow)).toThrow(
            expect.objectContaining({ code: 'INVALID_SIGNATURE' })
         );
      });

      it('rejects wrong-purpose tokens (e.g. unsubscribe token passed to verifyVerificationToken)', () => {
         const unsubToken = createUnsubscribeToken(wallet);

         expect(() => verifyVerificationToken(unsubToken, fixedNow)).toThrow(
            expect.objectContaining({ code: 'WRONG_PURPOSE' })
         );
      });

      it('rejects malformed tokens', () => {
         expect(() => verifyVerificationToken('invalid-token', fixedNow)).toThrow(
            expect.objectContaining({ code: 'MALFORMED_TOKEN' })
         );
         expect(() => verifyVerificationToken('', fixedNow)).toThrow(
            expect.objectContaining({ code: 'MALFORMED_TOKEN' })
         );
         expect(() => verifyVerificationToken('a.b.c', fixedNow)).toThrow(
            expect.objectContaining({ code: 'MALFORMED_TOKEN' })
         );
      });
   });

   describe('Unsubscribe Token', () => {
      it('creates and verifies a valid unsubscribe token', () => {
         const token = createUnsubscribeToken(wallet);
         const decoded = verifyUnsubscribeToken(token);

         expect(decoded.wallet).toBe(wallet);
      });

      it('rejects wrong-purpose tokens (e.g. verification token passed to verifyUnsubscribeToken)', () => {
         const verifyToken = createVerificationToken(wallet, email, fixedNow);

         expect(() => verifyUnsubscribeToken(verifyToken)).toThrow(
            expect.objectContaining({ code: 'WRONG_PURPOSE' })
         );
      });

      it('rejects tampered unsubscribe token signature', () => {
         const token = createUnsubscribeToken(wallet);
         const [data, sig] = token.split('.');
         const tamperedToken = `${data}.${sig.slice(0, -2)}xx`;

         expect(() => verifyUnsubscribeToken(tamperedToken)).toThrow(
            expect.objectContaining({ code: 'INVALID_SIGNATURE' })
         );
      });

      it('rejects malformed unsubscribe token', () => {
         expect(() => verifyUnsubscribeToken('not-a-token')).toThrow(
            expect.objectContaining({ code: 'MALFORMED_TOKEN' })
         );
      });
   });
});
