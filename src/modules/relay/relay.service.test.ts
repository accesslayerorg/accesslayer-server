// src/modules/relay/relay.service.test.ts
// Unit tests for the gasless meta-transaction relay service (#1088).

const mockCache = new Map<string, any>();

jest.mock('../../utils/redis.utils', () => ({
   cacheGet: jest.fn(async (key: string) =>
      mockCache.has(key) ? JSON.stringify(mockCache.get(key)) : null
   ),
   cacheGetJson: jest.fn(async (key: string) =>
      mockCache.has(key) ? mockCache.get(key) : null
   ),
   cacheSetJson: jest.fn(async (key: string, val: any) => {
      mockCache.set(key, val);
   }),
   cacheInvalidate: jest.fn(async (...keys: string[]) => {
      keys.forEach(key => mockCache.delete(key));
   }),
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

import {
   reserveWalletNonce,
   submitRelayTransaction,
   checkRelayRateLimit,
   reservationToResponse,
   defaultSigner,
   defaultSubmitter,
   RELAY_NONCE_RESERVATION_TTL_SECONDS,
} from './relay.service';
import {
   RelayNonceExpiredError,
   RelayNonceNotReservedError,
   RelayNonceAlreadyUsedError,
   RelayInvalidSignatureError,
   RelaySubmissionError,
} from './relay.errors';
import { resetNonceStateForTests } from '../nonce/nonce.service';

const VALID_WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const ANOTHER_WALLET =
   'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB2KM';

const validSignature = 'valid-signature';
const validTxParams = 'eyJ0eXBlIjoicHJpY2UifQ=='; // arbitrary payload

describe('Relay Service (#1088)', () => {
   beforeEach(() => {
      mockCache.clear();
      resetNonceStateForTests();
      jest.clearAllMocks();
   });

   describe('reserveWalletNonce', () => {
      it('returns the next unused nonce (0) for a wallet with no contract configured', async () => {
         const reservation = await reserveWalletNonce(VALID_WALLET);

         expect(reservation).toEqual({
            wallet: VALID_WALLET,
            nonce: 0,
            reservedAt: expect.any(String),
            expiresAt: expect.any(String),
         });

         // It is persisted in Redis with the 5-minute TTL
         const stored = mockCache.get(`relay:nonce:reserved:${VALID_WALLET}`);
         expect(stored).toEqual(reservation);
      });

      it('uses a 5-minute reservation TTL', async () => {
         await reserveWalletNonce(VALID_WALLET);

         const { cacheSetJson } = require('../../utils/redis.utils');
         const lastCall = (cacheSetJson as jest.Mock).mock.calls.at(-1);
         expect(lastCall[0]).toBe(`relay:nonce:reserved:${VALID_WALLET}`);
         expect(lastCall[2]).toBe(RELAY_NONCE_RESERVATION_TTL_SECONDS); // 300 seconds
      });

      it('returns the existing active reservation instead of creating a new one', async () => {
         const first = await reserveWalletNonce(VALID_WALLET);
         const second = await reserveWalletNonce(VALID_WALLET);

         expect(second.nonce).toBe(first.nonce);
         expect(second.expiresAt).toBe(first.expiresAt);
      });

      it('reserves nonces independently per wallet', async () => {
         const resA = await reserveWalletNonce(VALID_WALLET);
         const resB = await reserveWalletNonce(ANOTHER_WALLET);

         expect(resA.wallet).toBe(VALID_WALLET);
         expect(resB.wallet).toBe(ANOTHER_WALLET);
         expect(resA.nonce).toBe(0);
         expect(resB.nonce).toBe(0);
      });

      it('frees an expired reservation and creates a fresh one', async () => {
         const expiredReservation = {
            wallet: VALID_WALLET,
            nonce: 7,
            reservedAt: new Date(0).toISOString(),
            expiresAt: new Date(0).toISOString(), // long expired
         };
         mockCache.set(
            `relay:nonce:reserved:${VALID_WALLET}`,
            expiredReservation
         );

         const fresh = await reserveWalletNonce(VALID_WALLET);

         expect(fresh.nonce).toBe(0); // tracked on-chain nonce, not the expired 7
         expect(mockCache.has(`relay:nonce:reserved:${VALID_WALLET}`)).toBe(
            true
         );
         expect(
            mockCache.get(`relay:nonce:reserved:${VALID_WALLET}`).nonce
         ).toBe(0);
      });
   });

   describe('reservationToResponse', () => {
      it('reports remaining TTL and reserved flag', () => {
         const reservation = {
            wallet: VALID_WALLET,
            nonce: 3,
            reservedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(), // 1 minute from now
         };

         const response = reservationToResponse(reservation);

         expect(response.wallet).toBe(VALID_WALLET);
         expect(response.nonce).toBe(3);
         expect(response.reserved).toBe(true);
         expect(response.expiresInSeconds).toBeGreaterThan(50);
         expect(response.expiresInSeconds).toBeLessThanOrEqual(60);
      });

      it('reports reserved: false when the TTL has elapsed', () => {
         const reservation = {
            wallet: VALID_WALLET,
            nonce: 3,
            reservedAt: new Date().toISOString(),
            expiresAt: new Date(0).toISOString(),
         };

         expect(reservationToResponse(reservation).reserved).toBe(false);
      });
   });

   describe('checkRelayRateLimit', () => {
      it('allows the first 10 requests per wallet per minute', async () => {
         for (let i = 1; i <= 10; i += 1) {
            const result = await checkRelayRateLimit(VALID_WALLET);
            expect(result.allowed).toBe(true);
            expect(result.remaining).toBe(10 - i);
         }
      });

      it('rejects the 11th request within the same minute', async () => {
         for (let i = 0; i < 10; i += 1) {
            await checkRelayRateLimit(VALID_WALLET);
         }

         const result = await checkRelayRateLimit(VALID_WALLET);
         expect(result.allowed).toBe(false);
         expect(result.remaining).toBe(0);
      });

      it('tracks rate limits independently per wallet', async () => {
         for (let i = 0; i < 10; i += 1) {
            await checkRelayRateLimit(VALID_WALLET);
         }

         const exhausted = await checkRelayRateLimit(VALID_WALLET);
         expect(exhausted.allowed).toBe(false);

         const fresh = await checkRelayRateLimit(ANOTHER_WALLET);
         expect(fresh.allowed).toBe(true);
      });
   });

   describe('submitRelayTransaction', () => {
      const mockSigner = {
         verifySignature: jest.fn(async () => true),
      };
      const mockSubmitter = {
         submitTransaction: jest.fn(async () => ({
            txHash: '0xabcdef1234567890',
         })),
      };

      it('validates the reservation and signature, then submits and returns tx_hash', async () => {
         await reserveWalletNonce(VALID_WALLET);

         const result = await submitRelayTransaction(
            VALID_WALLET,
            0,
            validSignature,
            validTxParams,
            mockSigner,
            mockSubmitter
         );

         expect(result).toEqual({
            wallet: VALID_WALLET,
            nonce: 0,
            txHash: '0xabcdef1234567890',
         });
         expect(mockSigner.verifySignature).toHaveBeenCalledWith(
            VALID_WALLET,
            validSignature,
            validTxParams
         );
         expect(mockSubmitter.submitTransaction).toHaveBeenCalledWith(
            validTxParams
         );
      });

      it('does not submit when the signature is invalid', async () => {
         await reserveWalletNonce(VALID_WALLET);
         const failingSigner = { verifySignature: jest.fn(async () => false) };

         await expect(
            submitRelayTransaction(
               VALID_WALLET,
               0,
               'bad-signature',
               validTxParams,
               failingSigner,
               mockSubmitter
            )
         ).rejects.toThrow(RelayInvalidSignatureError);

         expect(mockSubmitter.submitTransaction).not.toHaveBeenCalled();
      });

      it('throws RelayNonceNotReservedError when no reservation exists', async () => {
         await expect(
            submitRelayTransaction(
               VALID_WALLET,
               0,
               validSignature,
               validTxParams,
               mockSigner,
               mockSubmitter
            )
         ).rejects.toThrow(RelayNonceNotReservedError);
      });

      it('throws RelayNonceExpiredError when the reservation expired', async () => {
         mockCache.set(`relay:nonce:reserved:${VALID_WALLET}`, {
            wallet: VALID_WALLET,
            nonce: 0,
            reservedAt: new Date(0).toISOString(),
            expiresAt: new Date(0).toISOString(),
         });

         await expect(
            submitRelayTransaction(
               VALID_WALLET,
               0,
               validSignature,
               validTxParams,
               mockSigner,
               mockSubmitter
            )
         ).rejects.toThrow(RelayNonceExpiredError);
      });

      it('throws RelayNonceAlreadyUsedError when the nonce was already consumed', async () => {
         mockCache.set(`relay:nonce:reserved:${VALID_WALLET}`, {
            wallet: VALID_WALLET,
            nonce: 0,
            reservedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
         });
         mockCache.set(`relay:nonce:consumed:${VALID_WALLET}:0`, {
            wallet: VALID_WALLET,
            nonce: 0,
            consumedAt: new Date().toISOString(),
         });

         await expect(
            submitRelayTransaction(
               VALID_WALLET,
               0,
               validSignature,
               validTxParams,
               mockSigner,
               mockSubmitter
            )
         ).rejects.toThrow(RelayNonceAlreadyUsedError);
      });

      it('throws RelaySubmissionError when on-chain submission fails', async () => {
         await reserveWalletNonce(VALID_WALLET);
         const failingSubmitter = {
            submitTransaction: jest.fn(async () => {
               throw new RelaySubmissionError(new Error('rpc down'));
            }),
         };

         await expect(
            submitRelayTransaction(
               VALID_WALLET,
               0,
               validSignature,
               validTxParams,
               mockSigner,
               failingSubmitter
            )
         ).rejects.toThrow(RelaySubmissionError);
      });

      it('invalidates the reservation after a successful submission', async () => {
         await reserveWalletNonce(VALID_WALLET);

         await submitRelayTransaction(
            VALID_WALLET,
            0,
            validSignature,
            validTxParams,
            mockSigner,
            mockSubmitter
         );

         // The reservation is released; a repeat submit finds no active reservation
         await expect(
            submitRelayTransaction(
               VALID_WALLET,
               0,
               validSignature,
               validTxParams,
               mockSigner,
               mockSubmitter
            )
         ).rejects.toThrow(RelayNonceNotReservedError);
      });
   });

   describe('defaultSigner / defaultSubmitter construction', () => {
      it('instantiates without configuration so the module loads in any environment', () => {
         expect(defaultSigner).toBeInstanceOf(defaultSigner.constructor);
         expect(defaultSubmitter).toBeInstanceOf(defaultSubmitter.constructor);
      });
   });
});
