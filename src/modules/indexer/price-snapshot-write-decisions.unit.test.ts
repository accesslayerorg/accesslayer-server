// src/modules/indexer/price-snapshot-write-decisions.unit.test.ts
// Unit tests for the write decisions taken by upsertPriceSnapshot():
//
//  1. A price equal to the previous snapshot does not move the snapshot price.
//  2. A price different from the previous snapshot updates the snapshot price.
//  3. The first snapshot for a creator is always written (nothing to compare).
//
// Note on (1): until ef59c18 ("compute full-window trade TWAP for issue 880")
// an unchanged price skipped the write entirely. That guard had to go because
// the TWAP window is computed from creator_price_history, so every trade must
// append a price point even when the price repeats. The invariant that still
// holds — and that these tests pin down — is that a repeated price leaves
// currentPrice and price24hAgo untouched.
//
// Unlike the debug-log suite, these assert on the whole transaction so that a
// stray snapshot write cannot slip through unnoticed.
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
      it('leaves currentPrice and price24hAgo untouched when the price repeats', async () => {
         mockPrisma.creatorPriceSnapshot.findUnique.mockResolvedValue(
            existingSnapshot()
         );

         await upsertPriceSnapshot({
            creatorId: CREATOR_ID,
            price: PREVIOUS_PRICE,
            tradeAt: NEW_TRADE_AT,
         });

         // The trade is newer than lastTradeAt, so the idempotency guard is not
         // what we are exercising here: the repeated price is.
         expect(mockPrisma.creatorPriceSnapshot.create).not.toHaveBeenCalled();
         expect(mockPrisma.creatorPriceSnapshot.update).toHaveBeenCalledTimes(
            1
         );

         const { data } =
            mockPrisma.creatorPriceSnapshot.update.mock.calls[0][0];
         expect(data.currentPrice).toEqual(PREVIOUS_PRICE);
         expect(data.price24hAgo).toEqual(BigInt(900_000));
      });

      it('appends the history point a repeated price still needs for TWAP', async () => {
         mockPrisma.creatorPriceSnapshot.findUnique.mockResolvedValue(
            existingSnapshot()
         );

         await upsertPriceSnapshot({
            creatorId: CREATOR_ID,
            price: PREVIOUS_PRICE,
            tradeAt: NEW_TRADE_AT,
         });

         expect(mockPrisma.creatorPriceHistory.create).toHaveBeenCalledTimes(1);
         expect(mockPrisma.creatorPriceHistory.create).toHaveBeenCalledWith({
            data: {
               creatorId: CREATOR_ID,
               price: PREVIOUS_PRICE,
               supply: 0n,
               direction: 'BUY',
               recordedAt: NEW_TRADE_AT,
            },
         });
      });

      it('skips both writes for a stale replay of the last trade', async () => {
         mockPrisma.creatorPriceSnapshot.findUnique.mockResolvedValue(
            existingSnapshot()
         );

         await upsertPriceSnapshot({
            creatorId: CREATOR_ID,
            price: PREVIOUS_PRICE,
            tradeAt: RECENT_TRADE_AT,
         });

         expect(mockPrisma.$transaction).not.toHaveBeenCalled();
         expect(mockPrisma.creatorPriceSnapshot.update).not.toHaveBeenCalled();
         expect(mockPrisma.creatorPriceHistory.create).not.toHaveBeenCalled();
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
