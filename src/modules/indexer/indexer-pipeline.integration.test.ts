import { processTradeEvents } from './indexer-pipeline.service';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';

jest.mock('../../utils/prisma.utils', () => {
   const mockPrisma: any = {
      activity: {
         create: jest.fn(),
         findMany: jest.fn().mockResolvedValue([]),
      },
      keyOwnership: {
         findFirst: jest.fn(),
         upsert: jest.fn(),
         aggregate: jest.fn().mockResolvedValue({ _sum: { balance: 0 } }),
      },
      creatorPriceSnapshot: {
         findUnique: jest.fn(),
         create: jest.fn(),
         update: jest.fn(),
      },
      creatorPriceHistory: {
         create: jest.fn(),
      },
      creatorProfile: {
         findUnique: jest.fn().mockResolvedValue(null),
         update: jest.fn(),
      },
      indexedLedger: {
         upsert: jest.fn(),
      },
      // Supports both call styles used in the pipeline:
      // - prisma.$transaction([...]) — an array of already-invoked promises
      // - prisma.$transaction(async (tx) => {...}) — a callback receiving
      //   a transaction client (the mock just passes itself back)
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
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
   },
}));

const mockCacheInvalidate = jest.fn();

// processTradeEvents invalidates the volume leaderboard cache (#785) after
// creating each Activity row — stub Redis so that call resolves immediately
// instead of attempting a real connection.
jest.mock('../../utils/redis.utils', () => ({
   getRedis: jest.fn(() => ({
      del: jest.fn().mockResolvedValue(1),
   })),
   cacheInvalidate: mockCacheInvalidate,
}));

describe('processTradeEvents integration test', () => {
   const mockPrisma = prisma as unknown as {
      activity: { create: jest.Mock; findMany: jest.Mock };
      keyOwnership: { findFirst: jest.Mock; upsert: jest.Mock; aggregate: jest.Mock };
      creatorPriceSnapshot: { findUnique: jest.Mock; create: jest.Mock; update: jest.Mock };
      creatorPriceHistory: { create: jest.Mock };
      creatorProfile: { findUnique: jest.Mock; update: jest.Mock };
      indexedLedger: { upsert: jest.Mock };
      $transaction: jest.Mock;
   };
   const mockLogger = logger as unknown as {
      warn: jest.Mock;
   };

    beforeEach(() => {
       jest.clearAllMocks();
       mockPrisma.keyOwnership.upsert.mockResolvedValue({ balance: -50 });
       mockPrisma.keyOwnership.aggregate.mockResolvedValue({ _sum: { balance: 0 } });
       mockPrisma.activity.findMany.mockResolvedValue([]);
       mockPrisma.creatorProfile.findUnique.mockResolvedValue(null);
       mockPrisma.indexedLedger.upsert.mockResolvedValue({});
       mockPrisma.$transaction.mockImplementation(async (arg: any) => {
          if (typeof arg === 'function') {
             return arg(mockPrisma);
          }
          return Promise.all(arg);
       });
    });

   it('correctly processes and persists a valid sell event', async () => {
      const event: IndexerChainEvent = {
         txHash: '0xhash123',
         eventIndex: 0,
         eventType: 'KEY_SOLD',
         ledger: 12345,
         creatorId: 'creator-abc',
         actor: 'G_SELLER_ADDRESS',
         amount: 50,
         price: 2000n,
         feePaid: 10n,
         tradeAt: '2026-07-25T12:00:00.000Z',
      };

      mockPrisma.keyOwnership.findFirst.mockResolvedValue(null);
      mockPrisma.creatorPriceSnapshot.findUnique.mockResolvedValue(null);

      await processTradeEvents([event]);

      // 1. Assert Activity record created with correct fields
      expect(mockPrisma.activity.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.activity.create).toHaveBeenCalledWith({
         data: {
            type: 'KEY_SOLD',
            actor: 'G_SELLER_ADDRESS',
            creatorId: 'creator-abc',
            payload: {
               amount: 50,
               price_at_trade: '2000',
               fee_paid: '10',
               ledger_sequence: 12345,
            },
            createdAt: new Date('2026-07-25T12:00:00.000Z'),
         },
      });

      // 2. Assert updateOwnership was triggered (negative amount for sell)
      expect(mockPrisma.keyOwnership.upsert).toHaveBeenCalledTimes(1);
      expect(mockPrisma.keyOwnership.upsert).toHaveBeenCalledWith(
         expect.objectContaining({
            create: {
               ownerAddress: 'G_SELLER_ADDRESS',
               creatorId: 'creator-abc',
               balance: -50,
            },
         })
      );

      // 3. Assert upsertPriceSnapshot was triggered atomically with a
      // CreatorPriceHistory row (#893)
      expect(mockPrisma.creatorPriceSnapshot.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.creatorPriceSnapshot.create).toHaveBeenCalledWith({
         data: {
            creatorId: 'creator-abc',
            currentPrice: 2000n,
            price24hAgo: 2000n,
            lastTradeAt: new Date('2026-07-25T12:00:00.000Z'),
         },
      });
      expect(mockPrisma.creatorPriceHistory.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.creatorPriceHistory.create).toHaveBeenCalledWith({
         data: {
            creatorId: 'creator-abc',
            price: 2000n,
            supply: 0n,
            direction: 'SELL',
            recordedAt: new Date('2026-07-25T12:00:00.000Z'),
         },
      });
      // Both writes went through the same transaction call. $transaction is
      // also called once by persistCirculatingSupply (function-style) before
      // this, so find the array-style call used for the snapshot+history write.
      const snapshotTxCall = mockPrisma.$transaction.mock.calls.find(
         (call: any[]) => Array.isArray(call[0])
      );
      expect(snapshotTxCall).toBeDefined();
      expect(snapshotTxCall![0]).toHaveLength(2);
   });

   it('deduplicates sell events based on txHash and eventIndex', async () => {
      const event: IndexerChainEvent = {
         txHash: '0xhash123',
         eventIndex: 0,
         eventType: 'KEY_SOLD',
         ledger: 12345,
         creatorId: 'creator-abc',
         actor: 'G_SELLER_ADDRESS',
         amount: 50,
         price: 2000n,
         feePaid: 10n,
         tradeAt: '2026-07-25T12:00:00.000Z',
      };

      mockPrisma.keyOwnership.findFirst.mockResolvedValue(null);
      mockPrisma.creatorPriceSnapshot.findUnique.mockResolvedValue(null);

      // Pass duplicate events
      await processTradeEvents([event, event]);

      expect(mockPrisma.activity.create).toHaveBeenCalledTimes(1);
   });

   it('invalidates portfolio stats when a creator key is registered', async () => {
      await processTradeEvents([
         {
            txHash: '0xregistered',
            eventIndex: 0,
            eventType: 'CREATOR_REGISTERED',
            ledger: 12346,
            actor: 'G_DEPLOYER_ADDRESS',
         },
      ]);

      expect(mockCacheInvalidate).toHaveBeenCalledWith(
         'creator-portfolio:stats:v1:G_DEPLOYER_ADDRESS'
      );
      expect(mockPrisma.activity.create).not.toHaveBeenCalled();
   });

   it('skips a sell event with missing required fields and logs a warning', async () => {
      const malformedEvent: IndexerChainEvent = {
         txHash: '0xhash123',
         eventIndex: 0,
         eventType: 'KEY_SOLD',
         ledger: 12345,
         // creatorId is missing
         actor: 'G_SELLER_ADDRESS',
         amount: 50,
         price: 2000n,
         feePaid: 10n,
         tradeAt: '2026-07-25T12:00:00.000Z',
      } as any;

      await processTradeEvents([malformedEvent]);

      expect(mockPrisma.activity.create).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
         expect.objectContaining({ missingField: 'creatorId' }),
         expect.any(String)
      );
   });

   it('emits a warn log when checkpoint write fails and continues processing', async () => {
      const event: IndexerChainEvent = {
         txHash: '0xhash456',
         eventIndex: 0,
         eventType: 'KEY_SOLD',
         ledger: 99999,
         creatorId: 'creator-xyz',
         actor: 'G_BUYER_ADDRESS',
         amount: 30,
         price: 1500n,
         feePaid: 5n,
         tradeAt: '2026-07-25T13:00:00.000Z',
      };

      mockPrisma.keyOwnership.findFirst.mockResolvedValue(null);
      mockPrisma.creatorPriceSnapshot.findUnique.mockResolvedValue(null);
      mockPrisma.indexedLedger.upsert.mockRejectedValue(
         new Error('DB timeout')
      );

      await processTradeEvents([event]);

      // Processing still completes despite checkpoint failure
      expect(mockPrisma.activity.create).toHaveBeenCalledTimes(1);

      // A warn log is emitted for the checkpoint failure
      expect(mockLogger.warn).toHaveBeenCalledWith(
         expect.objectContaining({
            ledger: 99999,
            error_reason: 'DB timeout',
            failed_at: expect.any(String),
            batch_hash: expect.any(String),
         }),
         'Indexer checkpoint write failed'
      );
   });
});
