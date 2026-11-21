import {
   processIndexerEvents,
   processTradeEvents,
   advanceIndexerCursorForBatch,
} from './indexer-pipeline.service';
import {
   processSocialMetadataEvents,
   SOCIAL_METADATA_UPDATED_EVENT_TYPE,
} from './social-metadata-indexer.service';
import { processDividendEvents } from './dividend-indexer.service';
import { processRevenueShareEvents } from './revenue-share-indexer.service';
import { processGovernanceProposalEvents } from './governance-proposal-indexer.service';
import { processBadgeMintedEvents } from './badge-minted-indexer.service';
import { upsertPriceSnapshot } from './price-snapshot.service';
import { prisma } from '../../utils/prisma.utils';
import { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';

jest.mock('./social-metadata-indexer.service', () => ({
   processSocialMetadataEvents: jest.fn(),
   SOCIAL_METADATA_UPDATED_EVENT_TYPE: 'SOCIAL_METADATA_UPDATED',
}));

jest.mock('./dividend-indexer.service', () => ({
   processDividendEvents: jest.fn(),
}));
jest.mock('./revenue-share-indexer.service', () => ({
   processRevenueShareEvents: jest.fn(),
}));
jest.mock('./lp-indexer.service', () => {
   const actual = jest.requireActual('./lp-indexer.service');
   return {
      ...actual,
      processLpEvents: jest.fn().mockResolvedValue(undefined),
   };
});
jest.mock('./governance-proposal-indexer.service', () => ({
   processGovernanceProposalEvents: jest.fn(),
}));
jest.mock('./key-poll-indexer.service', () => ({
   processKeyPollEvents: jest.fn(),
}));
jest.mock('./badge-minted-indexer.service', () => ({
   BADGE_MINTED_EVENT_TYPES: new Set(['BadgeMinted', 'BADGE_MINTED']),
   processBadgeMintedEvents: jest.fn(),
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
const mockDividendHandler = processDividendEvents as jest.Mock;
const mockRevenueShareHandler = processRevenueShareEvents as jest.Mock;
const mockGovernanceHandler = processGovernanceProposalEvents as jest.Mock;
const mockKeyPollHandler = jest.requireMock('./key-poll-indexer.service')
   .processKeyPollEvents as jest.Mock;
const mockBadgeMintHandler = processBadgeMintedEvents as jest.Mock;
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

   it('routes community poll lifecycle events to their indexer', async () => {
      const pollEvent: IndexerChainEvent = {
         eventType: 'PollVoteCast',
         txHash: 'tx-poll-vote',
         eventIndex: 0,
         ledger: 720,
         keyId: 'key-1',
         pollId: 'poll-1',
         wallet: 'G123',
         optionIndex: 0,
         weight: '3',
      };

      await processIndexerEvents([pollEvent]);

      expect(mockKeyPollHandler).toHaveBeenCalledWith([pollEvent]);
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

   it('routes dividend snapshot and claim events to the dividend indexer', async () => {
      const snapshotEvent = socialEvent({
         txHash: 'tx-dividend-snapshot',
         eventType: 'DividendSnapshotCreated',
         ledger: 810,
      });
      const claimEvent = socialEvent({
         txHash: 'tx-dividend-claim',
         eventIndex: 1,
         eventType: 'DividendClaimed',
         ledger: 811,
      });

      await processIndexerEvents([snapshotEvent, claimEvent]);

      expect(mockDividendHandler).toHaveBeenCalledWith(
         [snapshotEvent, claimEvent],
         { advanceCursor: false }
      );
      expect(mockPrisma.indexedLedger.upsert).toHaveBeenCalledTimes(1);
   });

   it('routes BadgeMinted events before advancing the shared cursor', async () => {
      const event: IndexerChainEvent = {
         txHash: 'tx-badge',
         eventIndex: 1,
         eventType: 'BadgeMinted',
         ledger: 720,
      };

      await processIndexerEvents([event]);

      expect(mockBadgeMintHandler).toHaveBeenCalledWith([event]);
      expect(mockPrisma.indexedLedger.upsert).toHaveBeenCalledTimes(1);
   });

   it('does not advance the cursor when BadgeMinted projection fails', async () => {
      mockBadgeMintHandler.mockRejectedValueOnce(
         new Error('wallet badge write failed')
      );

      await expect(
         processIndexerEvents([
            {
               txHash: 'tx-badge-failed',
               eventIndex: 1,
               eventType: 'BadgeMinted',
               ledger: 721,
            },
         ])
      ).rejects.toThrow('wallet badge write failed');

      expect(mockPrisma.indexedLedger.upsert).not.toHaveBeenCalled();
   });

   it('routes creator revenue distribution and claim events before advancing the cursor', async () => {
      const distributionEvent = socialEvent({
         txHash: 'tx-revenue-distributed',
         eventType: 'RevenueDistributed',
         ledger: 812,
      });
      const claimEvent = socialEvent({
         txHash: 'tx-revenue-claimed',
         eventType: 'RevenueShareClaimed',
         ledger: 813,
      });

      await processIndexerEvents([distributionEvent, claimEvent]);

      expect(mockRevenueShareHandler).toHaveBeenCalledWith([
         distributionEvent,
         claimEvent,
      ]);
      expect(mockPrisma.indexedLedger.upsert).toHaveBeenCalledTimes(1);
      expect(mockPrisma.indexedLedger.upsert).toHaveBeenCalledWith(
         expect.objectContaining({
            update: expect.objectContaining({ ledger: 813 }),
         })
      );
   });

   it('does not advance the cursor if creator revenue indexing fails', async () => {
      mockRevenueShareHandler.mockRejectedValueOnce(
         new Error('revenue write failed')
      );

      await expect(
         processIndexerEvents([
            socialEvent({
               txHash: 'tx-revenue-failure',
               eventType: 'RevenueDistributed',
               ledger: 814,
            }),
         ])
      ).rejects.toThrow('revenue write failed');

      expect(mockPrisma.indexedLedger.upsert).not.toHaveBeenCalled();
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

   it('routes LP events to processLpEvents and ignores non-LP events', async () => {
      const { processLpEvents } = await import('./lp-indexer.service');
      const lpAdded = {
         txHash: 'tx-lp-1',
         eventIndex: 0,
         eventType: 'LiquidityAdded',
         ledger: 950,
         wallet: 'wallet-1',
         keyId: 'key-1',
         sharePercent: '10',
      };
      const nonLp = {
         txHash: 'tx-other',
         eventIndex: 0,
         eventType: 'OTHER_EVENT',
         ledger: 950,
      };

      await processIndexerEvents([lpAdded, nonLp]);

      expect(processLpEvents).toHaveBeenCalledTimes(1);
      expect(processLpEvents).toHaveBeenCalledWith([lpAdded]);
   });
});
