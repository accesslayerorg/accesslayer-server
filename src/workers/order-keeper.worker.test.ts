import { prisma } from '../utils/prisma.utils';
import {
   getOrderKeeperMetrics,
   resetOrderKeeperMetrics,
} from '../utils/order-keeper-metrics.utils';
import type {
   KeeperOrder,
   OrderKeeperClient,
} from './order-keeper.worker';
import { OrderKeeperWorker } from './order-keeper.worker';

jest.mock('../utils/prisma.utils', () => ({
   prisma: {
      limitOrder: {
         findMany: jest.fn(),
         updateMany: jest.fn(),
      },
      creatorPriceSnapshot: { findMany: jest.fn() },
   },
}));

const mockPrisma = prisma as unknown as {
   limitOrder: { findMany: jest.Mock; updateMany: jest.Mock };
   creatorPriceSnapshot: { findMany: jest.Mock };
};

const NOW = new Date('2026-11-20T12:00:00.000Z');
const KEY_ID = 'creator-key-1';

function makeOrder(overrides: Partial<KeeperOrder> = {}): KeeperOrder {
   return {
      id: 'order-1',
      wallet: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      keyId: KEY_ID,
      side: 'BUY',
      targetPrice: { toString: () => '0.5' },
      quantity: { toString: () => '2' },
      expiresAt: null,
      createdAt: new Date('2026-11-20T10:00:00.000Z'),
      ...overrides,
   };
}

function makeClient(
   overrides: Partial<jest.Mocked<OrderKeeperClient>> = {}
): jest.Mocked<OrderKeeperClient> {
   return {
      getOrderStatus: jest.fn().mockResolvedValue('OPEN'),
      simulateFill: jest.fn().mockResolvedValue({
         keeperRewardStroops: 1100n,
         estimatedFeeStroops: 1000n,
      }),
      getSequence: jest.fn().mockResolvedValue('5'),
      fillOrder: jest.fn().mockResolvedValue(undefined),
      ...overrides,
   };
}

function setPrice(currentPrice: bigint): void {
   mockPrisma.creatorPriceSnapshot.findMany.mockResolvedValue([
      { creatorId: KEY_ID, currentPrice },
   ]);
}

function makeWorker(client: OrderKeeperClient): OrderKeeperWorker {
   return new OrderKeeperWorker(client, {
      profitMarginBps: 1000,
      now: () => NOW,
   });
}

beforeEach(() => {
   jest.clearAllMocks();
   resetOrderKeeperMetrics();
   mockPrisma.limitOrder.findMany.mockResolvedValue([]);
   mockPrisma.limitOrder.updateMany.mockResolvedValue({ count: 1 });
});

describe('OrderKeeperWorker', () => {
   it('fills a profitable BUY order when the indexed price meets its target', async () => {
      const order = makeOrder();
      const client = makeClient();
      mockPrisma.limitOrder.findMany.mockResolvedValue([order]);
      setPrice(5_000_000n);

      await makeWorker(client).runCycle();

      expect(client.simulateFill).toHaveBeenCalledWith(order);
      expect(client.getSequence).toHaveBeenCalledTimes(1);
      expect(client.fillOrder).toHaveBeenCalledWith(order, '5');
      expect(mockPrisma.limitOrder.updateMany).toHaveBeenCalledWith({
         where: { id: order.id, status: { in: ['OPEN', 'EXECUTABLE'] } },
         data: { status: 'FILLED' },
      });
      expect(getOrderKeeperMetrics().keeper_fills_total.samples[0].value).toBe(
         1
      );
   });

   it('applies the inverse target condition to SELL orders', async () => {
      const order = makeOrder({
         side: 'SELL',
         targetPrice: { toString: () => '0.5' },
      });
      const client = makeClient();
      mockPrisma.limitOrder.findMany.mockResolvedValue([order]);
      setPrice(5_000_000n);

      await makeWorker(client).runCycle();

      expect(client.fillOrder).toHaveBeenCalledTimes(1);
   });

   it('skips an order while its target price condition is unmet', async () => {
      const client = makeClient();
      mockPrisma.limitOrder.findMany.mockResolvedValue([makeOrder()]);
      setPrice(8_000_000n);

      await makeWorker(client).runCycle();

      expect(client.simulateFill).not.toHaveBeenCalled();
      expect(client.fillOrder).not.toHaveBeenCalled();
      expect(getOrderKeeperMetrics().keeper_skipped_total.samples).toContainEqual(
         { labels: {}, value: 1 }
      );
   });

   it('skips a fill when the reward does not clear the configured margin', async () => {
      const order = makeOrder();
      const client = makeClient({
         simulateFill: jest.fn().mockResolvedValue({
            keeperRewardStroops: 1099n,
            estimatedFeeStroops: 1000n,
         }),
      });
      mockPrisma.limitOrder.findMany.mockResolvedValue([order]);
      setPrice(5_000_000n);

      await makeWorker(client).runCycle();

      expect(client.fillOrder).not.toHaveBeenCalled();
      expect(getOrderKeeperMetrics().keeper_skipped_total.samples).toContainEqual(
         { labels: {}, value: 1 }
      );
   });

   it.each([
      ['FILLED', 'FILLED'],
      ['CANCELLED', 'CANCELLED'],
      ['EXPIRED', 'EXPIRED'],
   ] as const)(
      'does not submit an order whose escrow status is %s',
      async (status, persistedStatus) => {
         const order = makeOrder();
         const client = makeClient({
            getOrderStatus: jest.fn().mockResolvedValue(status),
         });
         mockPrisma.limitOrder.findMany.mockResolvedValue([order]);
         setPrice(5_000_000n);

         await makeWorker(client).runCycle();

         expect(client.fillOrder).not.toHaveBeenCalled();
         expect(mockPrisma.limitOrder.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ data: { status: persistedStatus } })
         );
         expect(
            getOrderKeeperMetrics().keeper_skipped_total.samples
         ).toContainEqual({ labels: {}, value: 1 });
      }
   );

   it('marks a locally expired order without querying the escrow', async () => {
      const order = makeOrder({
         expiresAt: new Date('2026-11-20T11:59:59.000Z'),
      });
      const client = makeClient();
      mockPrisma.limitOrder.findMany.mockResolvedValue([order]);
      setPrice(1_000_000n);

      await makeWorker(client).runCycle();

      expect(client.getOrderStatus).not.toHaveBeenCalled();
      expect(client.fillOrder).not.toHaveBeenCalled();
      expect(mockPrisma.limitOrder.updateMany).toHaveBeenCalledWith(
         expect.objectContaining({ data: { status: 'EXPIRED' } })
      );
   });

   it('refreshes sequence and retries exactly once on tx_bad_seq', async () => {
      const order = makeOrder();
      const client = makeClient({
         getSequence: jest.fn().mockResolvedValueOnce('5').mockResolvedValueOnce('12'),
         fillOrder: jest
            .fn()
            .mockRejectedValueOnce(Object.assign(new Error('tx_bad_seq'), { code: 'tx_bad_seq' }))
            .mockResolvedValueOnce(undefined),
      });
      mockPrisma.limitOrder.findMany.mockResolvedValue([order]);
      setPrice(5_000_000n);

      await makeWorker(client).runCycle();

      expect(client.getSequence).toHaveBeenCalledTimes(2);
      expect(client.fillOrder.mock.calls).toEqual([
         [order, '5'],
         [order, '12'],
      ]);
      expect(getOrderKeeperMetrics().keeper_fills_total.samples[0].value).toBe(
         1
      );
   });

   it('does not retry a bad sequence more than once', async () => {
      const order = makeOrder();
      const badSequence = Object.assign(new Error('tx_bad_seq'), {
         code: 'tx_bad_seq',
      });
      const client = makeClient({
         getSequence: jest.fn().mockResolvedValueOnce('5').mockResolvedValueOnce('12'),
         fillOrder: jest.fn().mockRejectedValue(badSequence),
      });
      mockPrisma.limitOrder.findMany.mockResolvedValue([order]);
      setPrice(5_000_000n);

      await makeWorker(client).runCycle();

      expect(client.fillOrder).toHaveBeenCalledTimes(2);
      expect(getOrderKeeperMetrics().keeper_fills_total.samples[0].value).toBe(
         0
      );
      expect(getOrderKeeperMetrics().keeper_skipped_total.samples).toContainEqual(
         { labels: {}, value: 1 }
      );
   });

   it('checks escrow status before skipping when no indexed price is available', async () => {
      const client = makeClient();
      mockPrisma.limitOrder.findMany.mockResolvedValue([makeOrder()]);
      mockPrisma.creatorPriceSnapshot.findMany.mockResolvedValue([]);

      await makeWorker(client).runCycle();

      expect(client.getOrderStatus).toHaveBeenCalledWith('order-1');
      expect(getOrderKeeperMetrics().keeper_skipped_total.samples).toContainEqual(
         { labels: {}, value: 1 }
      );
   });

   it('skips a filled escrow order even when its indexed price is missing', async () => {
      const client = makeClient({
         getOrderStatus: jest.fn().mockResolvedValue('FILLED'),
      });
      mockPrisma.limitOrder.findMany.mockResolvedValue([makeOrder()]);
      mockPrisma.creatorPriceSnapshot.findMany.mockResolvedValue([]);

      await makeWorker(client).runCycle();

      expect(client.fillOrder).not.toHaveBeenCalled();
      expect(mockPrisma.limitOrder.updateMany).toHaveBeenCalledWith(
         expect.objectContaining({ data: { status: 'FILLED' } })
      );
      expect(getOrderKeeperMetrics().keeper_skipped_total.samples).toContainEqual(
         { labels: {}, value: 1 }
      );
   });
});
