import { prisma } from '../../utils/prisma.utils';
import { cacheInvalidate } from '../../utils/redis.utils';
import {
   IndexerChainEvent,
   processIndexerChainEvents,
} from '../../utils/indexer-event-processor.utils';
import { holderMilestoneCacheKeys } from '../keys/holder-milestones.service';

export const MILESTONE_REWARD_CLAIMED_EVENT_TYPES = new Set([
   'MilestoneRewardClaimed',
   'MILESTONE_REWARD_CLAIMED',
]);

function dateFrom(value: unknown): Date {
   const n = Number(value);
   const date =
      value != null && value !== ''
         ? new Date(
              Number.isFinite(n) && /^\d+$/.test(String(value))
                 ? n < 1e12
                    ? n * 1000
                    : n
                 : String(value)
           )
         : new Date();
   return Number.isNaN(date.getTime()) ? new Date() : date;
}

export async function processMilestoneRewardClaimedEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!MILESTONE_REWARD_CLAIMED_EVENT_TYPES.has(event.eventType)) return;
      const keyId = String(event.keyId ?? event.creatorId ?? '').trim();
      const wallet = String(
         event.wallet ?? event.holder ?? event.actor ?? ''
      ).trim();
      const milestoneDays = Number(
         event.milestoneDays ?? event.milestone ?? event.days
      );
      if (
         !keyId ||
         !wallet ||
         !Number.isInteger(milestoneDays) ||
         milestoneDays < 0
      ) {
         throw new Error(
            `Invalid ${event.eventType}: keyId, wallet and milestoneDays are required`
         );
      }
      await prisma.milestoneClaim.upsert({
         where: {
            txHash_eventIndex: {
               txHash: event.txHash,
               eventIndex: event.eventIndex,
            },
         },
         create: {
            keyId,
            wallet,
            milestoneDays,
            rewardAmount:
               event.rewardAmount == null
                  ? undefined
                  : String(event.rewardAmount),
            claimedAt: dateFrom(
               event.claimedAt ?? event.occurredAt ?? event.timestamp
            ),
            txHash: event.txHash,
            eventIndex: event.eventIndex,
            ledger: Number(event.ledger ?? 0),
         },
         update: {},
      });
      await cacheInvalidate(
         holderMilestoneCacheKeys.key(keyId, wallet),
         holderMilestoneCacheKeys.wallet(wallet)
      );
   });
}
