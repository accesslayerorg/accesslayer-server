// src/modules/indexer/whitelist-pipeline-dispatch.test.ts
// Verifies pipeline dispatcher's cursor semantics for WalletWhitelisted
// and WalletRemovedFromWhitelist events (#1084).

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
jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      activity: { create: jest.fn() },
      indexedLedger: { upsert: jest.fn() },
      creatorProfile: { findFirst: jest.fn(), findUnique: jest.fn() },
      registeredKey: { findFirst: jest.fn() },
      whitelist: {
         createMany: jest.fn().mockResolvedValue({ count: 1 }),
         deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
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
   creatorProfile: { findFirst: jest.Mock };
   whitelist: { createMany: jest.Mock; deleteMany: jest.Mock };
};

const W1 = 'G' + 'A'.repeat(55);

const whitelistEvent = (
   eventType: string,
   txHash: string,
   ledger: number,
   wallets: string[] = [W1]
) => ({
   txHash,
   eventIndex: 0,
   eventType,
   ledger,
   creatorId: 'key-1',
   wallets,
});

describe('processIndexerEvents with Whitelist events (#1084)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockPrisma.indexedLedger.upsert.mockResolvedValue({});
      mockPrisma.creatorProfile.findFirst.mockResolvedValue({ id: 'key-1' });
      mockPrisma.whitelist.createMany.mockResolvedValue({ count: 1 });
      mockPrisma.whitelist.deleteMany.mockResolvedValue({ count: 1 });
   });

   it('indexes WalletWhitelisted events and advances cursor to max ledger', async () => {
      await processIndexerEvents([
         whitelistEvent('WalletWhitelisted', 'tx-w1', 600),
         whitelistEvent('WalletWhitelisted', 'tx-w2', 605),
      ]);

      expect(mockPrisma.whitelist.createMany).toHaveBeenCalledTimes(2);
      expect(mockPrisma.indexedLedger.upsert).toHaveBeenCalledTimes(1);
      expect(mockPrisma.indexedLedger.upsert).toHaveBeenCalledWith(
         expect.objectContaining({
            update: expect.objectContaining({ ledger: 605 }),
         })
      );
   });

   it('indexes WalletRemovedFromWhitelist events and advances cursor', async () => {
      await processIndexerEvents([
         whitelistEvent('WalletRemovedFromWhitelist', 'tx-w3', 610),
      ]);

      expect(mockPrisma.whitelist.deleteMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.indexedLedger.upsert).toHaveBeenCalledTimes(1);
      expect(mockPrisma.indexedLedger.upsert).toHaveBeenCalledWith(
         expect.objectContaining({
            update: expect.objectContaining({ ledger: 610 }),
         })
      );
   });
});
