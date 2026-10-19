jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      stake: {
         upsert: jest.fn(),
         findUnique: jest.fn(),
         update: jest.fn(),
      },
      epochReward: {
         upsert: jest.fn(),
      },
   },
}));

jest.mock('../../utils/indexer-event-processor.utils', () => ({
   processIndexerChainEvents: jest.fn(async (events: any[], fn: (e: any) => Promise<void>) => {
      for (const event of events) {
         await fn(event);
      }
   }),
}));

import { prisma } from '../../utils/prisma.utils';
import {
   processStakingEpochEvents,
   isStakingEpochEventType,
} from './staking-epoch-indexer.service';

const stakeUpsert = (prisma as any).stake.upsert as jest.Mock;
const stakeFindUnique = (prisma as any).stake.findUnique as jest.Mock;
const stakeUpdate = (prisma as any).stake.update as jest.Mock;
const epochRewardUpsert = (prisma as any).epochReward.upsert as jest.Mock;

describe('staking-epoch-indexer.service (#1086)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('isStakingEpochEventType', () => {
      it('recognizes EpochRewardDistributed, StakeCreated, and RewardsClaimed', () => {
         expect(isStakingEpochEventType('EpochRewardDistributed')).toBe(true);
         expect(isStakingEpochEventType('EPOCH_REWARD_DISTRIBUTED')).toBe(true);
         expect(isStakingEpochEventType('StakeCreated')).toBe(true);
         expect(isStakingEpochEventType('STAKE_CREATED')).toBe(true);
         expect(isStakingEpochEventType('RewardsClaimed')).toBe(true);
         expect(isStakingEpochEventType('REWARDS_CLAIMED')).toBe(true);
         expect(isStakingEpochEventType('UnrelatedEvent')).toBe(false);
      });
   });

   describe('processStakingEpochEvents', () => {
      it('indexes EpochRewardDistributed event', async () => {
         epochRewardUpsert.mockResolvedValue({});

         await processStakingEpochEvents([
            {
               eventType: 'EpochRewardDistributed',
               keyId: 'key-100',
               epoch: 3,
               totalDistributed: '1500.0000000',
               rewardPerToken: '0.3000000',
               distributedAt: '2026-10-19T00:00:00Z',
               txHash: '0xreward123',
               ledger: 600,
               eventIndex: 0,
            } as any,
         ]);

         expect(epochRewardUpsert).toHaveBeenCalledTimes(1);
         expect(epochRewardUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
               where: {
                  keyId_epoch: {
                     keyId: 'key-100',
                     epoch: 3,
                  },
               },
               create: expect.objectContaining({
                  keyId: 'key-100',
                  epoch: 3,
                  totalDistributed: '1500.0000000',
                  rewardPerToken: '0.3000000',
                  txHash: '0xreward123',
               }),
            })
         );
      });

      it('indexes StakeCreated event', async () => {
         stakeUpsert.mockResolvedValue({});

         await processStakingEpochEvents([
            {
               eventType: 'StakeCreated',
               stakeId: 'stake-999',
               wallet: 'GWALLET1',
               keyId: 'key-100',
               amount: '250.0000000',
               startEpoch: 2,
               lockEpochs: 6,
               txHash: '0xstake123',
               ledger: 601,
               eventIndex: 0,
            } as any,
         ]);

         expect(stakeUpsert).toHaveBeenCalledTimes(1);
         expect(stakeUpsert).toHaveBeenCalledWith(
            expect.objectContaining({
               where: { stakeId: 'stake-999' },
               create: expect.objectContaining({
                  stakeId: 'stake-999',
                  wallet: 'GWALLET1',
                  keyId: 'key-100',
                  amount: '250.0000000',
                  startEpoch: 2,
                  lockEpochs: 6,
                  status: 'active',
                  txHash: '0xstake123',
               }),
            })
         );
      });

      it('indexes RewardsClaimed event and increments totalClaimed', async () => {
         stakeFindUnique.mockResolvedValue({
            stakeId: 'stake-999',
            totalClaimed: '20.0000000',
         });
         stakeUpdate.mockResolvedValue({});

         await processStakingEpochEvents([
            {
               eventType: 'RewardsClaimed',
               stakeId: 'stake-999',
               amount: '15.5000000',
               claimedAt: '2026-10-19T12:00:00Z',
               txHash: '0xclaim123',
               ledger: 602,
               eventIndex: 0,
            } as any,
         ]);

         expect(stakeUpdate).toHaveBeenCalledTimes(1);
         expect(stakeUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
               where: { stakeId: 'stake-999' },
               data: expect.objectContaining({
                  totalClaimed: 35.5,
               }),
            })
         );
      });
   });
});
