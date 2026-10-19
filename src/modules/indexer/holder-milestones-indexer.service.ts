import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { invalidateHolderMilestonesCache } from '../milestones/holder-milestones.service';

export const MILESTONE_CLAIM_EVENT_TYPES = [
   'MilestoneRewardClaimed',
   'MILESTONE_REWARD_CLAIMED',
] as const;

export function isMilestoneClaimEventType(eventType: string): boolean {
   return (MILESTONE_CLAIM_EVENT_TYPES as readonly string[]).includes(eventType);
}

export interface MilestoneRewardClaimedEvent extends IndexerChainEvent {
   keyId?: string;
   creatorId?: string;
   wallet?: string;
   holderAddress?: string;
   actor?: string;
   milestoneId?: string;
   tier?: number | string;
   claimedAt?: string | number | Date;
   txHash: string;
   ledger?: number;
   blockNumber?: number | bigint;
}

/**
 * Indexes MilestoneRewardClaimed events into milestone_claims table (#1115).
 */
export async function processMilestoneClaimEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   const claimEvents = events.filter(e => isMilestoneClaimEventType(e.eventType));
   if (claimEvents.length === 0) return;

   await processIndexerChainEvents(claimEvents, async rawEvent => {
      const event = rawEvent as unknown as MilestoneRewardClaimedEvent;
      const keyId = event.keyId || event.creatorId;
      const wallet = event.wallet || event.holderAddress || event.actor;

      if (!keyId || !wallet) {
         logger.warn({ rawEvent }, 'MilestoneRewardClaimed event missing keyId or wallet');
         return;
      }

      const tierNum = event.tier !== undefined && event.tier !== null ? Number(event.tier) : null;
      const milestoneId =
         event.milestoneId || (tierNum ? `holding_tier_${tierNum}` : 'holding_claimed');
      const claimedAt = event.claimedAt ? new Date(event.claimedAt) : new Date();
      const blockNum = event.blockNumber ?? event.ledger ?? null;

      await (prisma as any).milestoneClaim.upsert({
         where: {
            keyId_wallet_milestoneId: {
               keyId,
               wallet,
               milestoneId,
            },
         },
         update: {
            tier: tierNum,
            claimedAt,
            txHash: event.txHash ?? null,
            blockNumber: blockNum !== null ? BigInt(blockNum) : null,
         },
         create: {
            keyId,
            wallet,
            milestoneId,
            tier: tierNum,
            claimedAt,
            txHash: event.txHash ?? null,
            blockNumber: blockNum !== null ? BigInt(blockNum) : null,
         },
      });

      await invalidateHolderMilestonesCache(keyId, wallet);
   });
}
