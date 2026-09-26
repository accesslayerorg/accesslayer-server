import { executeMultiBuy, MultiBuyError } from './multi-buy.service';

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
   },
}));

const DEFAULT_SUPPLY = 5;
const CURRENT_LEDGER = 1000;
const BUYER_BALANCE = 1_000_000_000_000n;

function makeProviders(
   overrides: {
      ledger?: number;
      balance?: bigint;
      supply?: number | Record<string, number>;
   } = {}
) {
   const supplyMap =
      typeof overrides.supply === 'object' ? overrides.supply : undefined;
   const flatSupply =
      typeof overrides.supply === 'number' ? overrides.supply : DEFAULT_SUPPLY;

   return {
      ledger: {
         getCurrentLedger: jest
            .fn()
            .mockResolvedValue(overrides.ledger ?? CURRENT_LEDGER),
      },
      balance: {
         getXlmBalance: jest
            .fn()
            .mockResolvedValue(overrides.balance ?? BUYER_BALANCE),
      },
      supply: {
         getCreatorSupply: jest.fn().mockImplementation((creatorId: string) => {
            if (supplyMap && creatorId in supplyMap) {
               return Promise.resolve(supplyMap[creatorId]);
            }
            return Promise.resolve(flatSupply);
         }),
      },
   };
}

describe('executeMultiBuy (#717)', () => {
   it('executes 3 legs all within max_price and returns correct results', async () => {
      const legs = [
         { creator: 'creator-a', amount: 1, max_price: '100000000' },
         { creator: 'creator-b', amount: 1, max_price: '100000000' },
         { creator: 'creator-c', amount: 1, max_price: '100000000' },
      ];

      const results = await executeMultiBuy(
         'buyer-1',
         legs,
         2000,
         makeProviders()
      );

      expect(results).toHaveLength(3);
      for (let i = 0; i < 3; i++) {
         expect(results[i].creator).toBe(legs[i].creator);
         expect(results[i].amount).toBe(1);
         expect(results[i].new_supply).toBe(DEFAULT_SUPPLY + 1);
         expect(BigInt(results[i].total_cost)).toBeGreaterThan(0n);
      }
   });

   it('rolls back all legs when the second leg exceeds max_price', async () => {
      const legs = [
         { creator: 'creator-a', amount: 1, max_price: '100000000' },
         { creator: 'creator-b', amount: 1, max_price: '1' },
         { creator: 'creator-c', amount: 1, max_price: '100000000' },
      ];

      await expect(
         executeMultiBuy('buyer-1', legs, 2000, makeProviders())
      ).rejects.toThrow(MultiBuyError);

      try {
         await executeMultiBuy('buyer-1', legs, 2000, makeProviders());
      } catch (err) {
         expect((err as MultiBuyError).code).toBe('slippage_exceeded');
      }
   });

   it('rejects duplicate creator in legs', async () => {
      const legs = [
         { creator: 'creator-a', amount: 1, max_price: '100000000' },
         { creator: 'creator-a', amount: 2, max_price: '100000000' },
      ];

      try {
         await executeMultiBuy('buyer-1', legs, 2000, makeProviders());
         fail('Expected MultiBuyError');
      } catch (err) {
         expect(err).toBeInstanceOf(MultiBuyError);
         expect((err as MultiBuyError).code).toBe('duplicate_creator');
      }
   });

   it('rejects legs vector with more than 10 entries', async () => {
      const legs = Array.from({ length: 11 }, (_, i) => ({
         creator: `creator-${i}`,
         amount: 1,
         max_price: '100000000',
      }));

      try {
         await executeMultiBuy('buyer-1', legs, 2000, makeProviders());
         fail('Expected MultiBuyError');
      } catch (err) {
         expect(err).toBeInstanceOf(MultiBuyError);
         expect((err as MultiBuyError).code).toBe('too_many_legs');
      }
   });

   it('rejects when global_deadline_ledger is in the past', async () => {
      const legs = [
         { creator: 'creator-a', amount: 1, max_price: '100000000' },
      ];

      try {
         await executeMultiBuy(
            'buyer-1',
            legs,
            500,
            makeProviders({ ledger: CURRENT_LEDGER })
         );
         fail('Expected MultiBuyError');
      } catch (err) {
         expect(err).toBeInstanceOf(MultiBuyError);
         expect((err as MultiBuyError).code).toBe('deadline_passed');
      }
   });

   it('rejects when buyer balance is insufficient for worst-case cost', async () => {
      const legs = [
         { creator: 'creator-a', amount: 1, max_price: '100000000' },
      ];

      try {
         await executeMultiBuy(
            'buyer-1',
            legs,
            2000,
            makeProviders({ balance: 1n })
         );
         fail('Expected MultiBuyError');
      } catch (err) {
         expect(err).toBeInstanceOf(MultiBuyError);
         expect((err as MultiBuyError).code).toBe('insufficient_funds');
      }
   });
});
