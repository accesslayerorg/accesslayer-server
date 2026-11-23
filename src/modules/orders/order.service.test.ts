// src/modules/orders/order.service.test.ts
// #1220: target validation relative to the current curve price and
// owner-only cancellation.

import { prisma } from '../../utils/prisma.utils';
import { cancelLimitOrder, createLimitOrder } from './order.service';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorPriceSnapshot: { findUnique: jest.fn() },
      limitOrder: {
         create: jest.fn(),
         findUnique: jest.fn(),
         delete: jest.fn(),
      },
   },
}));

const mockPrisma = prisma as unknown as {
   creatorPriceSnapshot: { findUnique: jest.Mock };
   limitOrder: {
      create: jest.Mock;
      findUnique: jest.Mock;
      delete: jest.Mock;
   };
};

const WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER_WALLET = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const KEY_ID = 'creator-key-1';

const BASE_INPUT = {
   keyId: KEY_ID,
   side: 'BUY' as const,
   targetPrice: 0.5,
   quantity: 2,
};

beforeEach(() => {
   jest.clearAllMocks();
   // Current curve price: 1 XLM === 10,000,000 stroops.
   mockPrisma.creatorPriceSnapshot.findUnique.mockResolvedValue({
      currentPrice: 10_000_000n,
   });
   mockPrisma.limitOrder.create.mockImplementation(async (args: any) => ({
      id: 'order-1',
      ...args.data,
   }));
});

describe('createLimitOrder (#1220)', () => {
   it('rejects a buy target at or above the current price with 400', async () => {
      for (const targetPrice of [1, 1.5]) {
         await expect(
            createLimitOrder(WALLET, { ...BASE_INPUT, targetPrice })
         ).rejects.toMatchObject({ statusCode: 400 });
      }
      expect(mockPrisma.limitOrder.create).not.toHaveBeenCalled();
   });

   it('rejects a sell target at or below the current price with 400', async () => {
      for (const targetPrice of [1, 0.5]) {
         await expect(
            createLimitOrder(WALLET, {
               ...BASE_INPUT,
               side: 'SELL',
               targetPrice,
            })
         ).rejects.toMatchObject({ statusCode: 400 });
      }
      expect(mockPrisma.limitOrder.create).not.toHaveBeenCalled();
   });

   it('creates an OPEN buy order below the current price', async () => {
      const order = await createLimitOrder(WALLET, BASE_INPUT);

      expect(mockPrisma.limitOrder.create).toHaveBeenCalledWith(
         expect.objectContaining({
            data: expect.objectContaining({
               wallet: WALLET,
               keyId: KEY_ID,
               side: 'BUY',
               targetPrice: 0.5,
               quantity: 2,
               status: 'OPEN',
            }),
         })
      );
      expect(order.id).toBe('order-1');
   });

   it('creates a sell order above the current price', async () => {
      await createLimitOrder(WALLET, {
         ...BASE_INPUT,
         side: 'SELL',
         targetPrice: 2,
      });

      expect(mockPrisma.limitOrder.create).toHaveBeenCalled();
   });

   it('rejects orders for keys without an indexed price', async () => {
      mockPrisma.creatorPriceSnapshot.findUnique.mockResolvedValue(null);

      await expect(
         createLimitOrder(WALLET, BASE_INPUT)
      ).rejects.toMatchObject({ statusCode: 400 });
   });
});

describe('cancelLimitOrder (#1220)', () => {
   it('returns 403 when a different wallet tries to cancel', async () => {
      mockPrisma.limitOrder.findUnique.mockResolvedValue({
         id: 'order-1',
         wallet: WALLET,
         keyId: KEY_ID,
      });

      await expect(
         cancelLimitOrder('order-1', OTHER_WALLET)
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(mockPrisma.limitOrder.delete).not.toHaveBeenCalled();
   });

   it('deletes the order when the owner cancels', async () => {
      mockPrisma.limitOrder.findUnique.mockResolvedValue({
         id: 'order-1',
         wallet: WALLET,
         keyId: KEY_ID,
      });
      mockPrisma.limitOrder.delete.mockResolvedValue({});

      const result = await cancelLimitOrder('order-1', WALLET);

      expect(result).toEqual({ id: 'order-1' });
      expect(mockPrisma.limitOrder.delete).toHaveBeenCalledWith({
         where: { id: 'order-1' },
      });
   });

   it('returns null for an unknown order', async () => {
      mockPrisma.limitOrder.findUnique.mockResolvedValue(null);

      expect(await cancelLimitOrder('missing', WALLET)).toBeNull();
   });
});
