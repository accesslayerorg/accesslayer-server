// src/modules/indexer/dutch-auction-pipeline-dispatch.test.ts
// Verifies the pipeline routes Dutch auction events to the indexer and
// advances the ledger cursor (#1281).

jest.mock('../ownership/ownership.service', () => ({
   updateOwnership: jest.fn(),
   recordKeyPurchase: jest.fn(),
   recordKeySale: jest.fn(),
}));
jest.mock('./price-snapshot.service', () => ({
   upsertPriceSnapshot: jest.fn(),
}));
jest.mock('./persist-circulating-supply.service', () => ({
   persistCirculatingSupply: jest.fn().mockResolvedValue(0),
}));
jest.mock('../creators/creator-leaderboard-volume.service', () => ({
   invalidateVolumeLeaderboardCache: jest.fn(),
}));
jest.mock('../referrals/referrals.service', () => ({
   recordFirstTradeReferralReward: jest.fn(),
}));
jest.mock('../creators/creator-portfolio.service', () => ({
   invalidateCreatorPortfolioStatsCache: jest.fn(),
}));
jest.mock('../activity/activity-feed.service', () => ({
   invalidateActivityFeedCache: jest.fn(),
}));
jest.mock('./social-metadata-indexer.service', () => ({
   processSocialMetadataEvents: jest.fn(),
   SOCIAL_METADATA_UPDATED_EVENT_TYPE: 'SOCIAL_METADATA_UPDATED',
}));
jest.mock('../../utils/redis.utils', () => ({
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      activity: { create: jest.fn() },
      indexedLedger: { upsert: jest.fn() },
      creatorProfile: { findFirst: jest.fn(), findUnique: jest.fn() },
      registeredKey: { findFirst: jest.fn() },
      dutchAuction: {
         upsert: jest.fn().mockResolvedValue({}),
         findUnique: jest.fn(),
         update: jest.fn().mockResolvedValue({}),
         updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      dutchAuctionFill: {
         createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: jest.fn(),
   },
}));
jest.mock('../../utils/logger.utils', () => ({
   logger: {
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
      isLevelEnabled: jest.fn().mockReturnValue(false),
   },
}));

import { processIndexerEvents } from './indexer-pipeline.service';
import { prisma } from '../../utils/prisma.utils';

const mockPrisma = prisma as unknown as {
   indexedLedger: { upsert: jest.Mock };
   dutchAuction: {
      upsert: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
   };
   dutchAuctionFill: { createMany: jest.Mock };
   $transaction: jest.Mock;
};

describe('processIndexerEvents with Dutch auction events (#1281)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockPrisma.indexedLedger.upsert.mockResolvedValue({});
      mockPrisma.$transaction.mockImplementation(async (fn: any) =>
         fn(mockPrisma)
      );
   });

   it('routes auction_started to the Dutch auction indexer', async () => {
      await processIndexerEvents([
         {
            txHash: 'tx-1',
            eventIndex: 0,
            eventType: 'auction_started',
            ledger: 700,
            auctionId: 'a1',
            seller: 'GSELLER',
            keyId: 'key-1',
            quantity: 5,
            startPrice: '100',
            floorPrice: '10',
            durationLedgers: 60,
         },
      ]);

      expect(mockPrisma.dutchAuction.upsert).toHaveBeenCalledWith(
         expect.objectContaining({
            where: { id: 'a1' },
            create: expect.objectContaining({
               remaining: 5,
               startLedger: 700,
               status: 'open',
            }),
         })
      );
      expect(mockPrisma.indexedLedger.upsert).toHaveBeenCalledWith(
         expect.objectContaining({
            update: expect.objectContaining({ ledger: 700 }),
         })
      );
   });

   it('routes auction_cancelled and advances the cursor', async () => {
      await processIndexerEvents([
         {
            txHash: 'tx-2',
            eventIndex: 0,
            eventType: 'auction_cancelled',
            ledger: 710,
            auctionId: 'a1',
         },
      ]);

      expect(mockPrisma.dutchAuction.updateMany).toHaveBeenCalledWith({
         where: { id: 'a1', status: { in: ['open', 'ended'] } },
         data: { status: 'cancelled' },
      });
      expect(mockPrisma.indexedLedger.upsert).toHaveBeenCalledWith(
         expect.objectContaining({
            update: expect.objectContaining({ ledger: 710 }),
         })
      );
   });
});
