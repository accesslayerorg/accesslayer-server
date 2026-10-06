// src/modules/indexer/lp-indexer.service.ts
//
// LP position indexing (#980): handles LP_ADDED / LP_CLAIMED / LP_REMOVED
// events. LP_ADDED creates/upserts an LpPosition with the given share.
// LP_CLAIMED adds to accruedRewards. LP_REMOVED sets status = 'removed'.

import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { buildLogFields } from '../../utils/log-fields.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';

export interface LpChainEvent extends IndexerChainEvent {
   eventType: 'LP_ADDED' | 'LP_CLAIMED' | 'LP_REMOVED';
   wallet: string;
   keyId: string;
   /** Share percent, only meaningful for LP_ADDED (0-100). */
   sharePercent?: string;
   /** Reward amount claimed, only meaningful for LP_CLAIMED. */
   rewardAmount?: string;
}

function isValidEvent(event: IndexerChainEvent): event is LpChainEvent {
   const e = event as Partial<LpChainEvent>;
   if (
      (event.eventType !== 'LP_ADDED' &&
         event.eventType !== 'LP_CLAIMED' &&
         event.eventType !== 'LP_REMOVED') ||
      typeof e.wallet !== 'string' ||
      e.wallet.length === 0 ||
      typeof e.keyId !== 'string' ||
      e.keyId.length === 0
   ) {
      return false;
   }

   if (event.eventType === 'LP_ADDED') {
      const share = Number(e.sharePercent);
      return (
         typeof e.sharePercent === 'string' &&
         Number.isFinite(share) &&
         share >= 0
      );
   }

   if (event.eventType === 'LP_CLAIMED') {
      const reward = Number(e.rewardAmount);
      return (
         typeof e.rewardAmount === 'string' &&
         Number.isFinite(reward) &&
         reward >= 0
      );
   }

   return true;
}

/**
 * Applies LP_ADDED / LP_CLAIMED / LP_REMOVED events to LpPosition.
 *
 * Each event is recorded in LpEventLog inside the same transaction as the
 * position change; a replayed event violates the (txHash, eventIndex)
 * unique constraint and is skipped.
 */
export async function processLpEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (
         event.eventType !== 'LP_ADDED' &&
         event.eventType !== 'LP_CLAIMED' &&
         event.eventType !== 'LP_REMOVED'
      ) {
         return;
      }

      if (!isValidEvent(event)) {
         logger.warn(
            buildLogFields({
               type: 'lp_event_invalid',
               eventId: `${event.txHash}:${event.eventIndex}`,
            }),
            'Skipping LP event with missing or invalid fields'
         );
         return;
      }

      const { wallet, keyId } = event;

      try {
         await prisma.$transaction(async tx => {
            await tx.lpEventLog.create({
               data: {
                  txHash: String(event.txHash),
                  eventIndex: Number(event.eventIndex),
                  eventType: event.eventType,
               },
            });

            if (event.eventType === 'LP_ADDED') {
               const sharePercent = event.sharePercent as string;
               const existing = await tx.lpPosition.findFirst({
                  where: { wallet, keyId },
               });

               if (existing) {
                  await tx.lpPosition.update({
                     where: { id: existing.id },
                     data: { sharePercent, status: 'active' },
                  });
               } else {
                  await tx.lpPosition.create({
                     data: { wallet, keyId, sharePercent, status: 'active' },
                  });
               }
               return;
            }

            if (event.eventType === 'LP_CLAIMED') {
               const rewardAmount = event.rewardAmount as string;
               const existing = await tx.lpPosition.findFirst({
                  where: { wallet, keyId },
               });
               if (!existing) {
                  logger.warn(
                     buildLogFields({
                        type: 'lp_claim_no_position',
                        wallet,
                        keyId,
                        eventId: `${event.txHash}:${event.eventIndex}`,
                     }),
                     'LP_CLAIMED event references a wallet/key with no LpPosition'
                  );
                  return;
               }
               await tx.lpPosition.update({
                  where: { id: existing.id },
                  data: {
                     accruedRewards: {
                        increment: rewardAmount,
                     },
                  },
               });
               return;
            }

            // LP_REMOVED
            const existing = await tx.lpPosition.findFirst({
               where: { wallet, keyId },
            });
            if (!existing) {
               logger.warn(
                  buildLogFields({
                     type: 'lp_removed_no_position',
                     wallet,
                     keyId,
                     eventId: `${event.txHash}:${event.eventIndex}`,
                  }),
                  'LP_REMOVED event references a wallet/key with no LpPosition'
               );
               return;
            }
            await tx.lpPosition.update({
               where: { id: existing.id },
               data: { status: 'removed' },
            });
         });
      } catch (error) {
         if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
         ) {
            logger.debug(
               { eventId: `${event.txHash}:${event.eventIndex}` },
               'LP event already applied; skipping replay'
            );
            return;
         }
         throw error;
      }
   });
}

/**
 * Pro-rates a reward pool across active LpPosition rows for a key by
 * sharePercent, called from the trade indexer after each processed trade
 * (#980). This is a simplified accrual model: the reward pool per trade is a
 * fixed small fraction of the trade amount, not a precise on-chain fee split
 * — see the inline comment at the call site in trade-indexer.service.ts.
 */
export async function accrueLpRewards(
   keyId: string,
   tradeAmount: number
): Promise<void> {
   if (!keyId || !Number.isFinite(tradeAmount) || tradeAmount <= 0) {
      return;
   }

   const LP_REWARD_POOL_BPS = 50; // 0.5% of trade amount, simplified placeholder
   const rewardPool = (tradeAmount * LP_REWARD_POOL_BPS) / 10_000;
   if (rewardPool <= 0) {
      return;
   }

   const activePositions = await prisma.lpPosition.findMany({
      where: { keyId, status: 'active' },
   });

   if (activePositions.length === 0) {
      return;
   }

   await Promise.all(
      activePositions.map(position => {
         const share = Number(position.sharePercent) / 100;
         const reward = rewardPool * share;
         if (reward <= 0) return Promise.resolve();
         return prisma.lpPosition.update({
            where: { id: position.id },
            data: { accruedRewards: { increment: reward } },
         });
      })
   );
}
