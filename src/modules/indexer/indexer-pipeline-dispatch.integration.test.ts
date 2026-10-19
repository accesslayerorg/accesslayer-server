import {
   processIndexerEvents,
   processTradeEvents,
   advanceIndexerCursorForBatch,
} from './indexer-pipeline.service';
import {
   processSocialMetadataEvents,
   SOCIAL_METADATA_UPDATED_EVENT_TYPE,
} from './social-metadata-indexer.service';
import { processGovernanceProposalEvents } from './governance-proposal-indexer.service';
import { upsertPriceSnapshot } from './price-snapshot.service';
import { prisma } from '../../utils/prisma.utils';
import { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';

jest.mock('./social-metadata-indexer.service', () => ({
   processSocialMetadataEvents: jest.fn(),
   SOCIAL_METADATA_UPDATED_EVENT_TYPE: 'SOCIAL_METADATA_UPDATED',
}));

jest.mock('./governance-proposal-indexer.service', () => ({
   processGovernanceProposalEvents: jest.fn(),
}));

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

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      activity: { create: jest.fn() },
      indexedLedger: { upsert: jest.fn() },
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

const mockSocialHandler = processSocialMetadataEvents as jest.Mock;
const mockGovernanceHandler = processGovernanceProposalEvents as jest.Mock;
const mockUpsertPriceSnapshot = upsertPriceSnapshot as jest.Mock;
const mockPrisma = prisma as unknown as {
   activity: { create: jest.Mock };
   indexedLedger: { upsert: jest.Mock };
};

function socialEvent(
   overrides: Partial<IndexerChainEvent> = {}
): IndexerChainEvent {
   return {
      txHash: 'tx-social',
      eventIndex: 0,
      eventType: SOCIAL_METADATA_UPDATED_EVENT_TYPE,
      ledger: 700,
      creatorId: 'creator-1',
      ...overrides,
   };
}

function buyEvent(
   overrides: Partial<IndexerChainEvent> = {}
): IndexerChainEvent {
   return {
      txHash: 'tx-buy',
      eventIndex: 0,
      eventType: 'KEY_BOUGHT',
      ledger: 705,
      creatorId: 'creator-1',
      actor: 'GBUYER',
      amount: 2,
      price: 1000n,
      feePaid: 10n,
      tradeAt: '2026-10-17T10:00:00.000Z',
      ...overrides,
   };
}

describe('processIndexerEvents', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockPrisma.activity.create.mockResolvedValue({});
      mockPrisma.indexedLedger.upsert.mockResolvedValue({});
      mockUpsertPriceSnapshot.mockResolvedValue(undefined);
   });

   it('routes social and trade events to their handlers and advances the cursor once', async () => {
      const events = [
         socialEvent({ txHash: 'tx-social-1', transactionIndex: 0 }),
         buyEvent(),
         socialEvent({ txHash: 'tx-social-2', eventIndex: 1, ledger: 710 }),
      ];

      await processIndexerEvents(events);

      // Social handler receives only social events
      expect(mockSocialHandler).toHaveBeenCalledTimes(1);
      const handledSocial = mockSocialHandler.mock
         .calls[0][0] as IndexerChainEvent[];
      expect(handledSocial).toHaveLength(2);
      expect(
         handledSocial.every(
            e => e.eventType === SOCIAL_METADATA_UPDATED_EVENT_TYPE
         )
      ).toBe(true);

      // Trade path ran (mocked read-model writers invoked)
      expect(mockPrisma.activity.create).toHaveBeenCalledTimes(1);
      expect(mockUpsertPriceSnapshot).toHaveBeenCalledTimes(1);

      // Cursor advanced exactly once, to the batch max ledger
      expect(mockPrisma.indexedLedger.upsert).toHaveBeenCalledTimes(1);
      expect(mockPrisma.indexedLedger.upsert).toHaveBeenCalledWith(
         expect.objectContaining({
            where: { id: 1 },
            update: expect.objectContaining({ ledger: 710 }),
         })
      );
   });

   it('advances the cursor for a batch containing only social events', async () => {
      await processIndexerEvents([socialEvent({ ledger: 800 })]);

      expect(mockSocialHandler).toHaveBeenCalledTimes(1);
      expect(mockPrisma.activity.create).not.toHaveBeenCalled();
      expect(mockPrisma.indexedLedger.upsert).toHaveBeenCalledTimes(1);
      expect(mockPrisma.indexedLedger.upsert).toHaveBeenCalledWith(
         expect.objectContaining({
            update: expect.objectContaining({ ledger: 800 }),
         })
      );
   });

   it('still advances the cursor for batches with only unknown event types', async () => {
      await processIndexerEvents([
         {
            txHash: 'tx-unknown',
            eventIndex: 0,
            eventType: 'SOMETHING_NEW',
            ledger: 820,
         },
      ]);

      expect(mockSocialHandler).not.toHaveBeenCalled();
      expect(mockPrisma.activity.create).not.toHaveBeenCalled();
      expect(mockPrisma.indexedLedger.upsert).toHaveBeenCalledTimes(1);
   });

   it('routes governance lifecycle events to the governance handler', async () => {
      await processIndexerEvents([
         {
            txHash: 'tx-gov-1',
            eventIndex: 0,
            eventType: 'ProposalCreated',
            ledger: 830,
            keyId: 'key-1',
            proposalId: 'prop-1',
         },
         {
            txHash: 'tx-gov-2',
            eventIndex: 0,
            eventType: 'VOTE_CAST',
            ledger: 831,
            keyId: 'key-1',
            proposalId: 'prop-1',
            voter: 'walletA',
            optionIndex: 0,
            weight: '5',
         },
      ]);

      expect(mockGovernanceHandler).toHaveBeenCalledTimes(1);
      const handled = mockGovernanceHandler.mock
         .calls[0][0] as IndexerChainEvent[];
      expect(handled).toHaveLength(2);
      expect(mockPrisma.indexedLedger.upsert).toHaveBeenCalledTimes(1);
   });

   it('does not double-advance the cursor when processing trades directly', async () => {
      await processTradeEvents([buyEvent({ ledger: 900 })]);

      expect(mockPrisma.indexedLedger.upsert).toHaveBeenCalledTimes(1);
      expect(mockPrisma.indexedLedger.upsert).toHaveBeenCalledWith(
         expect.objectContaining({
            update: expect.objectContaining({ ledger: 900 }),
         })
      );
   });

   it('advanceIndexerCursorForBatch deduplicates before computing the max ledger', async () => {
      await advanceIndexerCursorForBatch([
         socialEvent({ txHash: 'dup', eventIndex: 0, ledger: 100 }),
         socialEvent({ txHash: 'dup', eventIndex: 0, ledger: 100 }),
      ]);

      expect(mockPrisma.indexedLedger.upsert).toHaveBeenCalledTimes(1);
   });
});
