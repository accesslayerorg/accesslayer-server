// Verifies the pipeline dispatcher's cursor semantics for TWAPUpdated
// events, which is what the "no gaps" criterion rests on.

jest.mock('../ownership/ownership.service', () => ({
   updateOwnership: jest.fn(),
   recordKeyPurchase: jest.fn(),
   recordKeySale: jest.fn(),
}));
jest.mock('./price-snapshot.service', () => ({ upsertPriceSnapshot: jest.fn() }));
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
jest.mock('../../utils/indexer-dlq.utils', () => ({
   moveToDLQ: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      activity: { create: jest.fn() },
      indexedLedger: { upsert: jest.fn() },
      twapSnapshot: { create: jest.fn() },
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
   twapSnapshot: { create: jest.Mock };
};

const twap = (txHash: string, ledger: number) => ({
   txHash,
   eventIndex: 0,
   eventType: 'TWAP_UPDATED',
   ledger,
   creatorId: 'key-1',
   window: '1h',
   twapPrice: '100',
   observationCount: 4,
   computedAt: '2026-10-18T10:00:00.000Z',
});

describe('processIndexerEvents with TWAPUpdated', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockPrisma.indexedLedger.upsert.mockResolvedValue({});
      mockPrisma.twapSnapshot.create.mockResolvedValue({});
   });

   it('indexes TWAP events and advances the cursor to the batch max ledger', async () => {
      await processIndexerEvents([twap('a', 100), twap('b', 105)]);

      expect(mockPrisma.twapSnapshot.create).toHaveBeenCalledTimes(2);
      expect(mockPrisma.indexedLedger.upsert).toHaveBeenCalledTimes(1);
      expect(mockPrisma.indexedLedger.upsert).toHaveBeenCalledWith(
         expect.objectContaining({
            update: expect.objectContaining({ ledger: 105 }),
         })
      );
   });

   it('does NOT advance the cursor when indexing a TWAP event fails', async () => {
      mockPrisma.twapSnapshot.create.mockRejectedValue(new Error('db down'));

      await expect(
         processIndexerEvents([twap('a', 100), twap('b', 105)])
      ).rejects.toThrow('db down');

      expect(mockPrisma.indexedLedger.upsert).not.toHaveBeenCalled();
   });

   it('advances the cursor for a batch containing only TWAP events', async () => {
      await processIndexerEvents([twap('a', 300)]);
      expect(mockPrisma.indexedLedger.upsert).toHaveBeenCalledTimes(1);
   });
});
