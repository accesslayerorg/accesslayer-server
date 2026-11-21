// src/modules/nonce/nonce.service.test.ts
// Unit tests for nonce management, cache handling, and replay protection (#1039).

const mockCacheStore = new Map<string, any>();

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) =>
      mockCacheStore.has(key) ? mockCacheStore.get(key) : null
   ),
   cacheSetJson: jest.fn(async (key: string, val: any) => {
      mockCacheStore.set(key, val);
   }),
   cacheInvalidate: jest.fn(async (key: string) => {
      mockCacheStore.delete(key);
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
   getWalletNonce,
   consumeWalletNonce,
   isNonceConsumed,
   validateSignedActionNonce,
   resetNonceStateForTests,
   NonceAlreadyConsumedError,
   NonceMismatchError,
} from './nonce.service';
import {
   decodeNonceScVal,
   buildNonceViewXdr,
   fetchNonceFromContract,
   defaultNonceContractProvider,
} from './nonce.contract';
import { xdr } from '@stellar/stellar-base';

const TEST_WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const TEST_CONTRACT =
   'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

describe('Nonce Service & Replay Protection (#1039)', () => {
   beforeEach(() => {
      mockCacheStore.clear();
      resetNonceStateForTests();
      jest.clearAllMocks();
   });

   describe('getWalletNonce', () => {
      it('fetches nonce from contract provider on cold cache and sets cache', async () => {
         const mockProvider = {
            getWalletNonce: jest.fn().mockResolvedValue(5),
         };

         const first = await getWalletNonce(TEST_WALLET, mockProvider);
         expect(first).toEqual({
            wallet: TEST_WALLET,
            nonce: 5,
            cached: false,
         });
         expect(mockProvider.getWalletNonce).toHaveBeenCalledTimes(1);

         // Second call should be served from cache without invoking provider
         const second = await getWalletNonce(TEST_WALLET, mockProvider);
         expect(second).toEqual({
            wallet: TEST_WALLET,
            nonce: 5,
            cached: true,
         });
         expect(mockProvider.getWalletNonce).toHaveBeenCalledTimes(1);
      });

      it('prevents redundant contract calls under load', async () => {
         const mockProvider = {
            getWalletNonce: jest.fn().mockResolvedValue(10),
         };

         // First call populates cache
         await getWalletNonce(TEST_WALLET, mockProvider);

         // 10 concurrent requests
         const results = await Promise.all(
            Array.from({ length: 10 }).map(() =>
               getWalletNonce(TEST_WALLET, mockProvider)
            )
         );

         expect(mockProvider.getWalletNonce).toHaveBeenCalledTimes(1);
         expect(results.every(r => r.cached === true && r.nonce === 10)).toBe(
            true
         );
      });
   });

   describe('consumeWalletNonce & Replay Detection', () => {
      it('consumes a valid nonce, advances the next expected nonce, and clears stale cache', async () => {
         const initial = await getWalletNonce(TEST_WALLET);
         expect(initial.nonce).toBe(0);

         const consumed = await consumeWalletNonce(
            TEST_WALLET,
            0,
            'governance:create_proposal'
         );
         expect(consumed).toEqual({
            wallet: TEST_WALLET,
            consumedNonce: 0,
            nextNonce: 1,
         });

         // Check that stale cache was invalidated: next getWalletNonce reflects incremented nonce
         const updated = await getWalletNonce(TEST_WALLET);
         expect(updated.nonce).toBe(1);
         expect(updated.cached).toBe(false);
      });

      it('immediately rejects consumed nonces with NonceAlreadyConsumedError (409)', async () => {
         await consumeWalletNonce(TEST_WALLET, 0, 'admin:pause');

         // Immediate replay attempt of the same nonce
         await expect(
            consumeWalletNonce(TEST_WALLET, 0, 'admin:pause')
         ).rejects.toThrow(NonceAlreadyConsumedError);

         try {
            await consumeWalletNonce(TEST_WALLET, 0, 'admin:pause');
         } catch (error) {
            expect(error).toBeInstanceOf(NonceAlreadyConsumedError);
            expect((error as NonceAlreadyConsumedError).status).toBe(409);
            expect((error as NonceAlreadyConsumedError).nonce).toBe(0);
            expect((error as NonceAlreadyConsumedError).wallet).toBe(
               TEST_WALLET
            );
         }
      });

      it('rejects an older nonce (< current nonce) with NonceAlreadyConsumedError (409)', async () => {
         await consumeWalletNonce(TEST_WALLET, 0, 'action1');
         await consumeWalletNonce(TEST_WALLET, 1, 'action2');

         // Nonce 0 is less than current (2)
         await expect(
            consumeWalletNonce(TEST_WALLET, 0, 'replay_action')
         ).rejects.toThrow(NonceAlreadyConsumedError);
      });

      it('rejects out-of-order nonces with NonceMismatchError (400)', async () => {
         await expect(
            consumeWalletNonce(TEST_WALLET, 5, 'action')
         ).rejects.toThrow(NonceMismatchError);

         try {
            await consumeWalletNonce(TEST_WALLET, 5, 'action');
         } catch (error) {
            expect(error).toBeInstanceOf(NonceMismatchError);
            expect((error as NonceMismatchError).status).toBe(400);
            expect((error as NonceMismatchError).expectedNonce).toBe(0);
            expect((error as NonceMismatchError).providedNonce).toBe(5);
         }
      });

      it('isNonceConsumed returns true for consumed nonces and false for unconsumed', async () => {
         expect(await isNonceConsumed(TEST_WALLET, 0)).toBe(false);
         await consumeWalletNonce(TEST_WALLET, 0, 'action');
         expect(await isNonceConsumed(TEST_WALLET, 0)).toBe(true);
         expect(await isNonceConsumed(TEST_WALLET, 1)).toBe(false);
      });

      it('validateSignedActionNonce executes consumption successfully', async () => {
         const res = await validateSignedActionNonce(
            TEST_WALLET,
            0,
            'signed_flow'
         );
         expect(res).toEqual({
            wallet: TEST_WALLET,
            consumedNonce: 0,
            nextNonce: 1,
         });

         await expect(
            validateSignedActionNonce(TEST_WALLET, 0, 'signed_flow')
         ).rejects.toThrow(NonceAlreadyConsumedError);
      });
   });

   describe('Contract Utilities & XDR Encoding', () => {
      it('decodes ScVal u32, i32, and u64 correctly', () => {
         const u32Val = xdr.ScVal.scvU32(42).toXDR('base64');
         expect(decodeNonceScVal(u32Val)).toBe(42);

         const i32Val = xdr.ScVal.scvI32(100).toXDR('base64');
         expect(decodeNonceScVal(i32Val)).toBe(100);

         const u64Val = xdr.ScVal.scvU64(xdr.Uint64.fromString('777')).toXDR(
            'base64'
         );
         expect(decodeNonceScVal(u64Val)).toBe(777);

         // Non-integer ScVal returns null
         const symVal = xdr.ScVal.scvSymbol('invalid').toXDR('base64');
         expect(decodeNonceScVal(symVal)).toBeNull();

         // Corrupted XDR returns null
         expect(decodeNonceScVal('not-valid-base64')).toBeNull();
      });

      it('builds a valid nonce view transaction XDR', () => {
         const txXdr = buildNonceViewXdr(TEST_CONTRACT, TEST_WALLET);
         expect(typeof txXdr).toBe('string');
         expect(txXdr.length).toBeGreaterThan(0);
      });

      it('fetchNonceFromContract returns null when contract is not configured', async () => {
         const result = await fetchNonceFromContract(TEST_WALLET, undefined);
         expect(result).toBeNull();
      });

      it('defaultNonceContractProvider falls back cleanly to tracked state', async () => {
         const nonce =
            await defaultNonceContractProvider.getWalletNonce(TEST_WALLET);
         expect(nonce).toBe(0);
      });
   });
});
