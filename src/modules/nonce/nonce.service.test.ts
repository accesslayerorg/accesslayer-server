import {
   consumeWalletNonce,
   getWalletNonce,
   NonceAlreadyConsumedError,
   NonceMismatchError,
   resetNonceStateForTests,
   validateSignedActionNonce,
} from './nonce.service';

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

const TEST_WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

describe('nonce management & replay protection (#1039)', () => {
   beforeEach(() => {
      mockCacheStore.clear();
      resetNonceStateForTests();
      jest.clearAllMocks();
   });

   it('fetches nonce from contract on cold cache and serves subsequent calls from cache', async () => {
      const provider = {
         getWalletNonce: jest.fn().mockResolvedValue(4),
      };

      const first = await getWalletNonce(TEST_WALLET, provider);
      expect(first).toEqual({ wallet: TEST_WALLET, nonce: 4, cached: false });
      expect(provider.getWalletNonce).toHaveBeenCalledTimes(1);

      const second = await getWalletNonce(TEST_WALLET, provider);
      expect(second).toEqual({ wallet: TEST_WALLET, nonce: 4, cached: true });
      expect(provider.getWalletNonce).toHaveBeenCalledTimes(1);
   });

   it('consumes a valid nonce, clears stale cache, and advances the expected nonce', async () => {
      const firstInfo = await getWalletNonce(TEST_WALLET);
      expect(firstInfo.nonce).toBe(0);

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

      const afterIncrement = await getWalletNonce(TEST_WALLET);
      expect(afterIncrement.nonce).toBe(1);
      expect(afterIncrement.cached).toBe(false);
   });

   it('rejects replayed nonces immediately with NonceAlreadyConsumedError (409)', async () => {
      await validateSignedActionNonce(TEST_WALLET, 0, 'admin:pause');

      await expect(
         validateSignedActionNonce(TEST_WALLET, 0, 'admin:pause')
      ).rejects.toThrow(NonceAlreadyConsumedError);

      await expect(
         validateSignedActionNonce(TEST_WALLET, 5, 'admin:pause')
      ).rejects.toThrow(NonceMismatchError);
   });
});
