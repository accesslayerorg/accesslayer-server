const mockOrderUpsert = jest.fn();
const mockOrderUpdateMany = jest.fn();
const mockOrderFindMany = jest.fn();
const mockFillUpsert = jest.fn();
const mockFillFindMany = jest.fn();

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      escrowOrder: {
         upsert: (...args: any[]) => mockOrderUpsert(...args),
         updateMany: (...args: any[]) => mockOrderUpdateMany(...args),
         findMany: (...args: any[]) => mockOrderFindMany(...args),
      },
      escrowFill: {
         upsert: (...args: any[]) => mockFillUpsert(...args),
         findMany: (...args: any[]) => mockFillFindMany(...args),
      },
   },
}));

import {
   getKeeperStats,
   handleOrderCancelled,
   handleOrderCreated,
   handleOrderExpiryReclaim,
   handleOrderFilled,
   reconcileOrders,
} from './escrow-order.service';

describe('escrow order service (#1351)', () => {
   beforeEach(() => jest.clearAllMocks());

   it('order_created upserts idempotently on orderId', async () => {
      await handleOrderCreated({
         orderId: 'o1',
         wallet: 'W',
         keyId: 'K',
         side: 'buy',
         lockedAmount: 100n,
         limitPrice: 10n,
         ledger: 1,
      });
      expect(mockOrderUpsert).toHaveBeenCalledWith(
         expect.objectContaining({ where: { id: 'o1' }, update: {} }),
      );
   });

   it('order_filled upserts the fill and only flips an open order', async () => {
      await handleOrderFilled({
         fillId: 'f1',
         orderId: 'o1',
         keeper: 'K1',
         fillPrice: 10n,
         fillAmount: 50n,
         keeperReward: 1n,
         ledger: 2,
      });
      expect(mockFillUpsert).toHaveBeenCalled();
      expect(mockOrderUpdateMany).toHaveBeenCalledWith(
         expect.objectContaining({
            where: { id: 'o1', status: 'open' },
            data: { status: 'filled' },
         }),
      );
   });

   it('replayed fill does not duplicate the fill row', async () => {
      await handleOrderFilled({
         fillId: 'f1',
         orderId: 'o1',
         keeper: 'K1',
         fillPrice: 10n,
         fillAmount: 50n,
         keeperReward: 1n,
         ledger: 2,
      });
      // upsert with empty update enforces idempotence on replay.
      expect(mockFillUpsert.mock.calls[0][0].update).toEqual({});
   });

   it('cancel and expiry only touch open orders', async () => {
      await handleOrderCancelled({ orderId: 'o1' });
      await handleOrderExpiryReclaim({ orderId: 'o2' });
      const whereClauses = mockOrderUpdateMany.mock.calls.map((c) => c[0].where.status);
      expect(whereClauses.every((s) => s === 'open')).toBe(true);
   });

   it('getKeeperStats aggregates fills and rewards per keeper', async () => {
      mockFillFindMany.mockResolvedValue([
         { keeper: 'K1', keeperReward: '10' },
         { keeper: 'K1', keeperReward: '5' },
         { keeper: 'K2', keeperReward: '20' },
      ]);
      const stats = await getKeeperStats();
      const byKeeper = Object.fromEntries(stats.map((s) => [s.keeper, s]));
      expect(byKeeper.K1).toEqual({ keeper: 'K1', fills: 2, totalReward: '15' });
      expect(byKeeper.K2).toEqual({ keeper: 'K2', fills: 1, totalReward: '20' });
   });

   it('reconcileOrders flags status divergence and missing on-chain rows', async () => {
      mockOrderFindMany.mockResolvedValue([
         { id: 'o1', status: 'filled' },
      ]);
      const diverged = await reconcileOrders([
         { id: 'o1', status: 'open' },
         { id: 'o2', status: 'open' },
      ]);
      expect(diverged).toEqual([
         { id: 'o1', offchainStatus: 'open', onchainStatus: 'filled' },
         { id: 'o2', offchainStatus: 'open', onchainStatus: null },
      ]);
   });
});
