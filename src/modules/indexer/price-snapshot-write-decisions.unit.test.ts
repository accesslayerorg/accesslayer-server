// src/modules/indexer/price-snapshot-write-decisions.unit.test.ts
// Unit tests for the write decisions taken by upsertPriceSnapshot():
//
//  1. A price equal to the previous snapshot results in no database write.
//  2. A price different from the previous snapshot results in a write.
//  3. The first snapshot for a creator is always written (nothing to compare).
//
// Unlike the debug-log suite, these assert on the whole transaction so that a
// stray write on the unchanged-price path cannot slip through unnoticed.
// Uses jest mocks — no database required.

import { upsertPriceSnapshot } from './price-snapshot.service';
import { prisma } from '../../utils/prisma.utils';

jest.mock('../../utils/prisma.utils', () => {
   const mockPrisma: any = {
      creatorPriceSnapshot: {
         findUnique: jest.fn(),
         create: jest.fn(),
         update: jest.fn(),
      },
      creatorPriceHistory: {
         create: jest.fn(),
      },
      $transaction: jest.fn(async (arg: any) => {
         if (typeof arg === 'function') {
            return arg(mockPrisma);
         }
         return Promise.all(arg);
      }),
   };
   return { prisma: mockPrisma };
});

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      debug: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
   },
}));

const mockPrisma = prisma as unknown as {
   creatorPriceSnapshot: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
   };
   creatorPriceHistory: {
      create: jest.Mock;
   };
   $transaction: jest.Mock;
};

const CREATOR_ID = 'creator-write-decisions-1';
const PREVIOUS_PRICE = BigInt(1_000_000);

// Timestamps are relative to now: upsertPriceSnapshot() rotates price24hAgo
// from the snapshots's wall-clock age, so fixed dates would make these tests
// change behaviour over time.
const RECENT_TRADE_AT = new Date(Date.now() - 60 * 60 * 1000); // 1 h ago
const NEW_TRADE_AT = new Date(Date.now() - 60 * 1000); // 1 min ago
const LATER_TRADE_AT = new Date(Date.now() - 30 * 1000); // 30 s ago

function existingSnapshot(overrides: Record<string, unknown> = {}) {
   return {
      creatorId: CREATOR_ID,
      currentPrice: PREVIOUS_PRICE,
      price24hAgo: BigInt(900_000),
      lastTradeAt: RECENT_TRADE_AT,
      ...overrides,
   };
}

describe('upsertPriceSnapshot() write decisions', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockPrisma.creatorPriceSnapshot.create.mockResolvedValue({});
      mockPrisma.creatorPriceSnapshot.update.mockResolvedValue({});
      mockPrisma.creatorPriceHistory.create.mockResolvedValue({});
   });

   describe('unchanged price', () => {
      it('performs no database write when the price equals the previous snapshot', async () => {
         mockPrisma.creatorPriceSnapshot.findUnique.mockResolvedValue(
            existingSnapshot()
         );

         await upsertPriceSnapshot({
            creatorId: CREATOR_ID,
            price: PREVIOUS_PRICE,
            tradeAt: NEW_TRADE_AT,
         });

         // The trade is newer than lastTradeAt, so the idempotency guard is not
         // what we are exercising here: the unchanged-price check must be.
         expect(mockPrisma.$transaction).not.toHaveBeenCalled();
         expect(mockPrisma.creatorPriceSnapshot.create).not.toHaveBeenCalled();
         expect(mockPrisma.creatorPriceSnapshot.update).not.toHaveBeenCalled();
         expect(mockPrisma.creatorPriceHistory.create).not.toHaveBeenCalled();
      });

      it('compares prices across differing bigint representations', async () => {
         mockPrisma.creatorPriceSnapshot.findUnique.mockResolvedValue(
            existingSnapshot({ currentPrice: BigInt(7) })
         );

         await upsertPriceSnapshot({
            creatorId: CREATOR_ID,
            price: BigInt(7),
            tradeAt: NEW_TRADE_AT,
         });

         expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      });

      it('still writes once a later trade changes the price', async () => {
         mockPrisma.creatorPriceSnapshot.findUnique.mockResolvedValue(
            existingSnapshot()
         );

         await upsertPriceSnapshot({
            creatorId: CREATOR_ID,
            price: PREVIOUS_PRICE,
            tradeAt: NEW_TRADE_AT,
         });
         await upsertPriceSnapshot({
            creatorId: CREATOR_ID,
            price: BigInt(2_000_000),
            tradeAt: LATER_TRADE_AT,
         });

         expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
         expect(mockPrisma.creatorPriceSnapshot.update).toHaveBeenCalledTimes(
            1
         );
         expect(mockPrisma.creatorPriceHistory.create).toHaveBeenCalledTimes(1);
      });
   });

   describe('changed price', () => {
      it('writes the snapshot and the history row when the price differs', async () => {
         mockPrisma.creatorPriceSnapshot.findUnique.mockResolvedValue(
            existingSnapshot()
         );

         const tradeAt = NEW_TRADE_AT;
         await upsertPriceSnapshot({
            creatorId: CREATOR_ID,
            price: BigInt(1_100_000),
            tradeAt,
         });

         expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
         expect(mockPrisma.$transaction.mock.calls[0][0]).toHaveLength(2);

         expect(mockPrisma.creatorPriceSnapshot.update).toHaveBeenCalledWith({
            where: { creatorId: CREATOR_ID },
            data: {
               currentPrice: BigInt(1_100_000),
               price24hAgo: BigInt(900_000),
               lastTradeAt: tradeAt,
            },
         });

         expect(mockPrisma.creatorPriceHistory.create).toHaveBeenCalledWith({
            data: {
               creatorId: CREATOR_ID,
               price: BigInt(1_100_000),
               supply: 0n,
               direction: 'BUY',
               recordedAt: tradeAt,
            },
         });
      });

      it('carries the supplied supply and direction into the history row', async () => {
         mockPrisma.creatorPriceSnapshot.findUnique.mockResolvedValue(
            existingSnapshot()
         );

         await upsertPriceSnapshot({
            creatorId: CREATOR_ID,
            price: BigInt(950_000),
            tradeAt: NEW_TRADE_AT,
            supply: BigInt(42),
            direction: 'SELL',
         });

         expect(mockPrisma.creatorPriceHistory.create).toHaveBeenCalledWith({
            data: {
               creatorId: CREATOR_ID,
               price: BigInt(950_000),
               supply: BigInt(42),
               direction: 'SELL',
               recordedAt: NEW_TRADE_AT,
            },
         });
      });
   });

   describe('first snapshot', () => {
      it('always writes when the creator has no previous snapshot', async () => {
         mockPrisma.creatorPriceSnapshot.findUnique.mockResolvedValue(null);

         await upsertPriceSnapshot({
            creatorId: CREATOR_ID,
            price: PREVIOUS_PRICE,
            tradeAt: NEW_TRADE_AT,
         });

         expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
         expect(mockPrisma.$transaction.mock.calls[0][0]).toHaveLength(2);

         expect(mockPrisma.creatorPriceSnapshot.create).toHaveBeenCalledWith({
            data: {
               creatorId: CREATOR_ID,
               currentPrice: PREVIOUS_PRICE,
               price24hAgo: PREVIOUS_PRICE,
               lastTradeAt: NEW_TRADE_AT,
            },
         });
         expect(mockPrisma.creatorPriceHistory.create).toHaveBeenCalledTimes(1);
         expect(mockPrisma.creatorPriceSnapshot.update).not.toHaveBeenCalled();
      });

      it('writes the first snapshot even at a price of zero', async () => {
         mockPrisma.creatorPriceSnapshot.findUnique.mockResolvedValue(null);

         await upsertPriceSnapshot({
            creatorId: CREATOR_ID,
            price: BigInt(0),
            tradeAt: NEW_TRADE_AT,
         });

         expect(mockPrisma.creatorPriceSnapshot.create).toHaveBeenCalledTimes(
            1
         );
         expect(mockPrisma.creatorPriceHistory.create).toHaveBeenCalledTimes(1);
      });
   });
});
