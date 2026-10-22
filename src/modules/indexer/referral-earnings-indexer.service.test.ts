// Unit tests: ReferralRewardDistributed indexer (#1057)
//
// Covers the acceptance criteria:
//   - valid reward events are persisted with the right fields
//   - malformed/invalid events are skipped without persisting
//   - duplicate events in a batch are indexed once (no double counting)
//   - the highest processed ledger is checkpointed (gap detection)

jest.mock('../referrals/referral-earnings.service', () => ({
   recordReferralEarning: jest.fn(),
}));

jest.mock('./ledger-gap-detection.service', () => ({
   updateIndexedLedger: jest.fn(),
}));

import { recordReferralEarning } from '../referrals/referral-earnings.service';
import { updateIndexedLedger } from './ledger-gap-detection.service';
import {
   processReferralRewardDistributedEvents,
   ReferralRewardDistributedEvent,
} from './referral-earnings-indexer.service';

const record = recordReferralEarning as jest.Mock;
const checkpoint = updateIndexedLedger as jest.Mock;

const WALLET = 'GA5XIGA5C7GTGTW7ZKJ4YV6OEILUY2Q7YIHZQNNDJUWAVES4O7D5SUK9';
const SOURCE = 'GSOURCEWALLET1234567890';

function event(
   overrides: Partial<ReferralRewardDistributedEvent> = {}
): ReferralRewardDistributedEvent {
   return {
      eventType: 'REFERRAL_REWARD_DISTRIBUTED',
      referrerWallet: WALLET,
      sourceWallet: SOURCE,
      tier: 1,
      amount: '5.5',
      distributedAt: '2026-08-20T10:00:00.000Z',
      ledger: 500,
      txHash: 'tx-1',
      eventIndex: 0,
      ...overrides,
   };
}

describe('processReferralRewardDistributedEvents', () => {
   beforeEach(() => jest.clearAllMocks());

   it('persists a valid reward event and checkpoints the ledger', async () => {
      await processReferralRewardDistributedEvents([event()]);

      expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith({
         referrerWallet: WALLET,
         sourceWallet: SOURCE,
         tier: 1,
         amount: 5.5,
         txHash: 'tx-1',
         eventIndex: 0,
         ledger: 500,
         earnedAt: new Date('2026-08-20T10:00:00.000Z'),
      });
      expect(checkpoint).toHaveBeenCalledWith(
         500,
         '500-000',
         expect.any(String)
      );
   });

   it('skips events missing a required field', async () => {
      await processReferralRewardDistributedEvents([
         event({ sourceWallet: undefined as unknown as string }),
      ]);

      expect(record).not.toHaveBeenCalled();
   });

   it('skips events with an invalid tier', async () => {
      await processReferralRewardDistributedEvents([event({ tier: 5 })]);

      expect(record).not.toHaveBeenCalled();
   });

   it('skips events with a non-positive amount', async () => {
      await processReferralRewardDistributedEvents([event({ amount: '0' })]);

      expect(record).not.toHaveBeenCalled();
   });

   it('skips events with an invalid timestamp', async () => {
      await processReferralRewardDistributedEvents([
         event({ distributedAt: 'not-a-date' }),
      ]);

      expect(record).not.toHaveBeenCalled();
   });

   it('indexes a duplicated event only once', async () => {
      await processReferralRewardDistributedEvents([event(), event()]);

      expect(record).toHaveBeenCalledTimes(1);
   });

   it('ignores unrelated event types', async () => {
      await processReferralRewardDistributedEvents([
         { ...event(), eventType: 'KEY_BOUGHT' },
      ]);

      expect(record).not.toHaveBeenCalled();
   });

   it('does not checkpoint when no events carry a ledger', async () => {
      await processReferralRewardDistributedEvents([
         event({ ledger: undefined }),
      ]);

      expect(checkpoint).not.toHaveBeenCalled();
   });
});
