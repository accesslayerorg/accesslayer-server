// Unit tests: ReferralTierUpgraded indexer (#1034)
//
// Covers the acceptance criteria:
//   - valid upgrade events are persisted with the right fields
//   - malformed/no-op transitions are skipped without persisting
//   - duplicate events in a batch are indexed once (no duplication)
//   - the highest processed ledger is checkpointed (gap detection)

jest.mock('../referrals/referral-tier.service', () => ({
   recordReferralTierUpgrade: jest.fn(),
}));

jest.mock('./ledger-gap-detection.service', () => ({
   updateIndexedLedger: jest.fn(),
}));

import { recordReferralTierUpgrade } from '../referrals/referral-tier.service';
import { updateIndexedLedger } from './ledger-gap-detection.service';
import {
   processReferralTierUpgradedEvents,
   ReferralTierUpgradedEvent,
} from './referral-tier-indexer.service';

const record = recordReferralTierUpgrade as jest.Mock;
const checkpoint = updateIndexedLedger as jest.Mock;

const WALLET = 'GA5XIGA5C7GTGTW7ZKJ4YV6OEILUY2Q7YIHZQNNDJUWAVES4O7D5SUK9';

function event(
   overrides: Partial<ReferralTierUpgradedEvent> = {}
): ReferralTierUpgradedEvent {
   return {
      eventType: 'REFERRAL_TIER_UPGRADED',
      walletAddress: WALLET,
      previousTier: 1,
      newTier: 2,
      cumulativeVolume: '1500',
      upgradedAt: '2026-09-01T00:00:00.000Z',
      ledger: 700,
      txHash: 'tx-1',
      eventIndex: 0,
      ...overrides,
   };
}

describe('processReferralTierUpgradedEvents', () => {
   beforeEach(() => jest.clearAllMocks());

   it('persists a valid upgrade and checkpoints the ledger', async () => {
      await processReferralTierUpgradedEvents([event()]);

      expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith({
         walletAddress: WALLET,
         previousTier: 1,
         newTier: 2,
         cumulativeVolume: 1500,
         txHash: 'tx-1',
         eventIndex: 0,
         ledger: 700,
         occurredAt: new Date('2026-09-01T00:00:00.000Z'),
      });
      expect(checkpoint).toHaveBeenCalledWith(
         700,
         '700-000',
         expect.any(String)
      );
   });

   it('skips events missing a required field', async () => {
      await processReferralTierUpgradedEvents([
         event({ walletAddress: undefined as unknown as string }),
      ]);

      expect(record).not.toHaveBeenCalled();
   });

   it('skips no-op or downward tier transitions', async () => {
      await processReferralTierUpgradedEvents([
         event({ previousTier: 2, newTier: 2 }),
      ]);
      await processReferralTierUpgradedEvents([
         event({ previousTier: 3, newTier: 1 }),
      ]);

      expect(record).not.toHaveBeenCalled();
   });

   it('skips events with an unconfigured tier', async () => {
      await processReferralTierUpgradedEvents([event({ newTier: 9 })]);

      expect(record).not.toHaveBeenCalled();
   });

   it('skips events with a negative cumulative volume', async () => {
      await processReferralTierUpgradedEvents([
         event({ cumulativeVolume: '-5' }),
      ]);

      expect(record).not.toHaveBeenCalled();
   });

   it('skips events with an invalid timestamp', async () => {
      await processReferralTierUpgradedEvents([
         event({ upgradedAt: 'not-a-date' }),
      ]);

      expect(record).not.toHaveBeenCalled();
   });

   it('indexes a duplicated event only once', async () => {
      await processReferralTierUpgradedEvents([event(), event()]);

      expect(record).toHaveBeenCalledTimes(1);
   });

   it('ignores unrelated event types', async () => {
      await processReferralTierUpgradedEvents([
         { ...event(), eventType: 'KEY_BOUGHT' },
      ]);

      expect(record).not.toHaveBeenCalled();
   });

   it('does not checkpoint when no events carry a ledger', async () => {
      await processReferralTierUpgradedEvents([event({ ledger: undefined })]);

      expect(checkpoint).not.toHaveBeenCalled();
   });
});
