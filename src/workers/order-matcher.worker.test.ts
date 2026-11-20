// src/workers/order-matcher.worker.test.ts
// #1220: the matcher flags buy/sell orders executable when the indexed price
// crosses their target, expires stale orders without ever making them
// executable, and pages through every OPEN order.

import { prisma } from '../utils/prisma.utils';
import {
   onOrderExecutable,
   OrderExecutableEvent,
} from '../modules/orders/order-events.utils';
import { runOrderMatcher } from './order-matcher.worker';

jest.mock('../utils/prisma.utils', () => ({
   prisma: {
      limitOrder: { findMany: jest.fn() },
      creatorPriceSnapshot: { findMany: jest.fn() },
      $transaction: jest.fn(),
   },
}));

const mockPrisma = prisma as unknown as {
   limitOrder: { findMany: jest.Mock };
   creatorPriceSnapshot: { findMany: jest.Mock };
   $transaction: jest.Mock;
};

const mockTx = {
   limitOrder: { updateMany: jest.fn() },
};

const NOW = new Date('2026-11-20T12:00:00.000Z');
const KEY_ID = 'creator-key-1';
const PAGE_SIZE = 500;

function makeOrder(overrides: Record<string, unknown> = {}) {
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

function setPrice(currentPrice: bigint) {
   mockPrisma.creatorPriceSnapshot.findMany.mockResolvedValue([
      { creatorId: KEY_ID, currentPrice },
   ]);
}

function executableUpdateIds(): string[] {
   const call = mockTx.limitOrder.updateMany.mock.calls.find(
      ([args]) => args?.data?.status === 'EXECUTABLE'
   );
   return call?.[0]?.where?.id?.in ?? [];
}

function expiredUpdateIds(): string[] {
   const call = mockTx.limitOrder.updateMany.mock.calls.find(
      ([args]) => args?.data?.status === 'EXPIRED'
   );
   return call?.[0]?.where?.id?.in ?? [];
}

let events: OrderExecutableEvent[] = [];
let unsubscribe: () => void;

beforeEach(() => {
   jest.clearAllMocks();
   mockPrisma.$transaction.mockImplementation(async (cb: any) => cb(mockTx));
   mockTx.limitOrder.updateMany.mockResolvedValue({ count: 1 });
   events = [];
   unsubscribe = onOrderExecutable(event => events.push(event));
});

afterEach(() => {
   unsubscribe();
});

describe('order matcher worker (#1220)', () => {
   it('marks a BUY order executable when price falls to its target', async () => {
      mockPrisma.limitOrder.findMany.mockResolvedValue([makeOrder()]);
      setPrice(500_000n); // 0.05 XLM <= 0.5 XLM target

      const result = await runOrderMatcher(NOW);

      expect(result.executable).toBe(1);
      expect(executableUpdateIds()).toEqual(['order-1']);
      expect(expiredUpdateIds()).toEqual([]);
   });

   it('marks a BUY order executable when price is exactly at its target', async () => {
      mockPrisma.limitOrder.findMany.mockResolvedValue([makeOrder()]);
      setPrice(5_000_000n); // 0.5 XLM === target

      const result = await runOrderMatcher(NOW);

      expect(result.executable).toBe(1);
      expect(executableUpdateIds()).toEqual(['order-1']);
   });

   it('leaves a BUY order open while price is above its target', async () => {
      mockPrisma.limitOrder.findMany.mockResolvedValue([makeOrder()]);
      setPrice(8_000_000n); // 0.8 XLM > 0.5 XLM target

      const result = await runOrderMatcher(NOW);

      expect(result.executable).toBe(0);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
   });

   it('marks a SELL order executable when price rises to its target', async () => {
      mockPrisma.limitOrder.findMany.mockResolvedValue([
         makeOrder({
            id: 'order-sell',
            side: 'SELL',
            targetPrice: { toString: () => '2' },
         }),
      ]);
      setPrice(20_000_000n); // 2 XLM === target

      const result = await runOrderMatcher(NOW);

      expect(result.executable).toBe(1);
      expect(executableUpdateIds()).toEqual(['order-sell']);
   });

   it('marks a SELL order executable when price is above its target', async () => {
      mockPrisma.limitOrder.findMany.mockResolvedValue([
         makeOrder({
            id: 'order-sell',
            side: 'SELL',
            targetPrice: { toString: () => '2' },
         }),
      ]);
      setPrice(25_000_000n); // 2.5 XLM > 2 XLM target

      const result = await runOrderMatcher(NOW);

      expect(result.executable).toBe(1);
   });

   it('leaves a SELL order open while price is below its target', async () => {
      mockPrisma.limitOrder.findMany.mockResolvedValue([
         makeOrder({
            id: 'order-sell',
            side: 'SELL',
            targetPrice: { toString: () => '2' },
         }),
      ]);
      setPrice(15_000_000n); // 1.5 XLM < 2 XLM target

      const result = await runOrderMatcher(NOW);

      expect(result.executable).toBe(0);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
   });

   it('expires an order past expiresAt even when the price condition is met', async () => {
      mockPrisma.limitOrder.findMany.mockResolvedValue([
         makeOrder({
            id: 'order-expired',
            expiresAt: new Date('2026-11-20T11:59:59.000Z'),
         }),
      ]);
      setPrice(100_000n); // well below the 0.5 XLM buy target

      const result = await runOrderMatcher(NOW);

      expect(result).toEqual({ scanned: 1, executable: 0, expired: 1 });
      expect(expiredUpdateIds()).toEqual(['order-expired']);
      expect(executableUpdateIds()).toEqual([]);
      expect(events).toHaveLength(0);
   });

   it('keeps an unexpired order open when neither condition is met', async () => {
      mockPrisma.limitOrder.findMany.mockResolvedValue([
         makeOrder({
            expiresAt: new Date('2026-11-21T12:00:00.000Z'),
         }),
      ]);
      setPrice(8_000_000n);

      const result = await runOrderMatcher(NOW);

      expect(result.expired).toBe(0);
      expect(result.executable).toBe(0);
   });

   it('applies executable and expired updates in a single transaction per page', async () => {
      mockPrisma.limitOrder.findMany.mockResolvedValue([
         makeOrder({ id: 'order-buy' }),
         makeOrder({ id: 'order-expired', side: 'SELL', expiresAt: new Date('2026-01-01T00:00:00.000Z') }),
         makeOrder({
            id: 'order-sell',
            side: 'SELL',
            targetPrice: { toString: () => '0.4' },
         }),
      ]);
      setPrice(500_000n);

      await runOrderMatcher(NOW);

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(expiredUpdateIds()).toEqual(['order-expired']);
      expect(executableUpdateIds()).toEqual(['order-buy']);
   });

   it('emits order.executable only for triggered orders, after the commit', async () => {
      mockPrisma.limitOrder.findMany.mockResolvedValue([makeOrder()]);
      setPrice(500_000n);

      await runOrderMatcher(NOW);

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
         type: 'order.executable',
         orderId: 'order-1',
         wallet: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
         keyId: KEY_ID,
         side: 'BUY',
         targetPrice: '0.5',
         quantity: '2',
         currentPrice: '500000',
      });
   });

   it('pages through a full page of open orders so newer orders are not starved', async () => {
      const base = new Date('2026-11-20T10:00:00.000Z').getTime();
      const firstPage = Array.from({ length: PAGE_SIZE }, (_, index) =>
         makeOrder({
            id: `open-${index}`,
            createdAt: new Date(base + index),
            targetPrice: { toString: () => '0.1' },
         })
      );
      const newestOrder = makeOrder({
         id: 'newest-order',
         createdAt: new Date(base + PAGE_SIZE + 1),
      });

      mockPrisma.limitOrder.findMany.mockImplementation(async (args: any) =>
         args.where.OR ? [newestOrder] : firstPage
      );
      setPrice(5_000_000n); // 0.5 XLM: above the old targets, at the newest target

      const result = await runOrderMatcher(NOW);

      expect(mockPrisma.limitOrder.findMany).toHaveBeenCalledTimes(2);
      expect(mockPrisma.limitOrder.findMany.mock.calls[1][0].where).toEqual({
         status: 'OPEN',
         OR: [
            { createdAt: { gt: firstPage[PAGE_SIZE - 1].createdAt } },
            {
               createdAt: firstPage[PAGE_SIZE - 1].createdAt,
               id: { gt: `open-${PAGE_SIZE - 1}` },
            },
         ],
      });
      expect(result).toEqual({
         scanned: PAGE_SIZE + 1,
         executable: 1,
         expired: 0,
      });
      expect(executableUpdateIds()).toEqual(['newest-order']);
      expect(events.map(event => event.orderId)).toEqual(['newest-order']);
   });

   it('does nothing when there are no open orders', async () => {
      mockPrisma.limitOrder.findMany.mockResolvedValue([]);

      const result = await runOrderMatcher(NOW);

      expect(result).toEqual({ scanned: 0, executable: 0, expired: 0 });
      expect(mockPrisma.creatorPriceSnapshot.findMany).not.toHaveBeenCalled();
   });
});
