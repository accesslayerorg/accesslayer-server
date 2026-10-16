import {
   getAvailableLiquidityDepth,
   InsufficientDepthError,
   validateBatchTradeDepth,
   validateSingleTradeDepth,
} from './liquidity-depth.service';
import { executeMultiBuy, MultiBuyError } from './multi-buy.service';

const mockCache = new Map<string, any>();

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) =>
      mockCache.has(key) ? mockCache.get(key) : null
   ),
   cacheSetJson: jest.fn(async (key: string, val: any) => {
      mockCache.set(key, val);
   }),
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
   },
}));

describe('liquidity depth pre-validation (#1038)', () => {
   beforeEach(() => {
      mockCache.clear();
      jest.clearAllMocks();
   });

   it('returns InsufficientDepth with max_available when a single buy or sell exceeds depth', async () => {
      const oracle = {
         get_max_buy: jest.fn().mockResolvedValue(50),
         get_max_sell: jest.fn().mockResolvedValue(20),
      };

      await expect(
         validateSingleTradeDepth('key-1', 'buy', 75, oracle)
      ).rejects.toMatchObject({
         name: 'InsufficientDepthError',
         code: 'InsufficientDepth',
         keyId: 'key-1',
         side: 'buy',
         requestedAmount: 75,
         max_available: 50,
      });

      await expect(
         validateSingleTradeDepth('key-1', 'sell', 25, oracle)
      ).rejects.toThrow(InsufficientDepthError);
   });

   it('caches depth results for 10 seconds to prevent redundant contract calls', async () => {
      const oracle = {
         get_max_buy: jest.fn().mockResolvedValue(100),
         get_max_sell: jest.fn().mockResolvedValue(40),
      };

      const d1 = await getAvailableLiquidityDepth('key-alpha', 'buy', oracle);
      const d2 = await getAvailableLiquidityDepth('key-alpha', 'buy', oracle);

      expect(d1).toBe(100);
      expect(d2).toBe(100);
      expect(oracle.get_max_buy).toHaveBeenCalledTimes(1);
   });

   it('returns per-order depth errors on batch trades and multi-buy legs', async () => {
      const oracle = {
         get_max_buy: jest.fn(async (keyId: string) =>
            keyId === 'creator-b' ? 5 : 100
         ),
         get_max_sell: jest.fn().mockResolvedValue(10),
      };

      const batchCheck = await validateBatchTradeDepth(
         [
            { keyId: 'creator-a', side: 'buy', amount: 10 },
            { keyId: 'creator-b', side: 'buy', amount: 12 },
            { keyId: 'creator-c', side: 'sell', amount: 15 },
         ],
         oracle
      );

      expect(batchCheck.valid).toBe(false);
      expect(batchCheck.errors).toEqual([
         {
            keyId: 'creator-b',
            side: 'buy',
            requestedAmount: 12,
            max_available: 5,
            code: 'InsufficientDepth',
         },
         {
            keyId: 'creator-c',
            side: 'sell',
            requestedAmount: 15,
            max_available: 10,
            code: 'InsufficientDepth',
         },
      ]);

      try {
         await executeMultiBuy(
            'buyer-1',
            [
               { creator: 'creator-a', amount: 2, max_price: '100000000' },
               { creator: 'creator-b', amount: 8, max_price: '100000000' },
            ],
            2000,
            {
               ledger: { getCurrentLedger: async () => 1000 },
               balance: { getXlmBalance: async () => 1_000_000_000_000n },
               supply: { getCreatorSupply: async () => 5 },
               depth: { getMaxBuy: oracle.get_max_buy },
            }
         );
         fail('Expected MultiBuyError InsufficientDepth');
      } catch (err) {
         const mbErr = err as MultiBuyError;
         expect(mbErr.code).toBe('InsufficientDepth');
         expect(mbErr.details?.max_available).toBe(5);
         expect(mbErr.details?.orderErrors).toHaveLength(1);
      }
   });
});
