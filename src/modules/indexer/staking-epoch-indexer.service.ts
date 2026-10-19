import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';

export const STAKING_EPOCH_EVENT_TYPES = [
   'EpochRewardDistributed',
   'EPOCH_REWARD_DISTRIBUTED',
   'StakeCreated',
   'STAKE_CREATED',
   'RewardsClaimed',
   'REWARDS_CLAIMED',
] as const;

export function isStakingEpochEventType(eventType: string): boolean {
   return (STAKING_EPOCH_EVENT_TYPES as readonly string[]).includes(eventType);
}

export interface EpochRewardDistributedEvent extends IndexerChainEvent {
   keyId: string;
   key_id?: string;
   epoch: number;
   totalDistributed: string | number;
   total_distributed?: string | number;
   rewardPerToken?: string | number;
   reward_per_token?: string | number;
   distributedAt?: string | number | Date;
   txHash: string;
}

export interface StakeCreatedEvent extends IndexerChainEvent {
   stakeId: string;
   stake_id?: string;
   wallet: string;
   keyId: string;
   key_id?: string;
   amount: string | number;
   startEpoch?: number;
   start_epoch?: number;
   lockEpochs?: number;
   lock_epochs?: number;
   txHash: string;
}

export interface RewardsClaimedEvent extends IndexerChainEvent {
   stakeId: string;
   stake_id?: string;
   wallet?: string;
   keyId?: string;
   amount: string | number;
   claimedAt?: string | number | Date;
   txHash: string;
}

/**
 * Indexes staking epoch rewards and stakes contract events (#1086).
 */
export async function processStakingEpochEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   const stakingEvents = events.filter(e => isStakingEpochEventType(e.eventType));
   if (stakingEvents.length === 0) return;

   await processIndexerChainEvents(stakingEvents, async rawEvent => {
      const eventType = rawEvent.eventType;

      if (
         eventType === 'EpochRewardDistributed' ||
         eventType === 'EPOCH_REWARD_DISTRIBUTED'
      ) {
         const event = rawEvent as unknown as EpochRewardDistributedEvent;
         const keyId = event.keyId || event.key_id;
         const epoch = Number(event.epoch);
         const totalDistributed = event.totalDistributed ?? event.total_distributed ?? '0';
         const rewardPerToken = event.rewardPerToken ?? event.reward_per_token ?? '0';

         if (!keyId || isNaN(epoch)) {
            logger.warn({ rawEvent }, 'EpochRewardDistributed missing keyId or epoch');
            return;
         }

         const distributedAt = event.distributedAt
            ? new Date(event.distributedAt)
            : new Date();

         await (prisma as any).epochReward.upsert({
            where: {
               keyId_epoch: {
                  keyId,
                  epoch,
               },
            },
            update: {
               totalDistributed,
               rewardPerToken,
               txHash: event.txHash ?? null,
               distributedAt,
            },
            create: {
               keyId,
               epoch,
               totalDistributed,
               rewardPerToken,
               txHash: event.txHash ?? null,
               distributedAt,
            },
         });
         return;
      }

      if (eventType === 'StakeCreated' || eventType === 'STAKE_CREATED') {
         const event = rawEvent as unknown as StakeCreatedEvent;
         const stakeId = event.stakeId || event.stake_id;
         const wallet = event.wallet;
         const keyId = event.keyId || event.key_id;
         const amount = event.amount;
         const startEpoch = Number(event.startEpoch ?? event.start_epoch ?? 0);
         const lockEpochs = Number(event.lockEpochs ?? event.lock_epochs ?? 1);

         if (!stakeId || !wallet || !keyId || amount === undefined) {
            logger.warn({ rawEvent }, 'StakeCreated missing required fields');
            return;
         }

         await (prisma as any).stake.upsert({
            where: { stakeId },
            update: {
               wallet,
               keyId,
               amount,
               startEpoch,
               lockEpochs,
               status: 'active',
               txHash: event.txHash ?? null,
            },
            create: {
               stakeId,
               wallet,
               keyId,
               amount,
               startEpoch,
               lockEpochs,
               status: 'active',
               txHash: event.txHash ?? null,
            },
         });
         return;
      }

      if (eventType === 'RewardsClaimed' || eventType === 'REWARDS_CLAIMED') {
         const event = rawEvent as unknown as RewardsClaimedEvent;
         const stakeId = event.stakeId || event.stake_id;
         const claimAmount = Number(event.amount || 0);

         if (!stakeId) {
            logger.warn({ rawEvent }, 'RewardsClaimed missing stakeId');
            return;
         }

         const existing = await (prisma as any).stake.findUnique({
            where: { stakeId },
         });

         if (!existing) {
            logger.warn({ stakeId }, 'RewardsClaimed referenced unknown stake');
            return;
         }

         const newTotal = Number(existing.totalClaimed || 0) + claimAmount;
         const claimedAt = event.claimedAt
            ? new Date(event.claimedAt)
            : new Date();

         await (prisma as any).stake.update({
            where: { stakeId },
            data: {
               totalClaimed: newTotal,
               claimedAt,
            },
         });
         return;
      }
   });
}
