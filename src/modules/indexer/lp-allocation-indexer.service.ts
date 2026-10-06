// src/modules/indexer/lp-allocation-indexer.service.ts
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { invalidateKeyLpStatsCache } from '../keys/key-lp.service';
import { invalidateLpOverviewCache } from '../admin/lp-overview.service';

/**
 * Chain event for the LPAllocationSent contract event (#943), emitted when a
 * bonding-curve buy sends its LP-allocated share of proceeds into the pool.
 */
export interface LPAllocationSentEvent extends IndexerChainEvent {
   eventType: 'LP_ALLOCATION_SENT';
   creatorId: string;
   amountXlm: string;
   allocatedAt: string; // ISO timestamp
}

/**
 * Processes a batch of LP_ALLOCATION_SENT events, storing one LpAllocation
 * row per event. Already-recorded events (same txHash + eventIndex) are
 * skipped so replays are idempotent. Invalidates the affected key's LP
 * stats cache and the admin protocol-wide LP overview cache on every new
 * allocation recorded.
 */
export async function processLpAllocationEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (event.eventType !== 'LP_ALLOCATION_SENT') {
         return;
      }

      const typedEvent = event as LPAllocationSentEvent;
      const requiredFields = [
         'creatorId',
         'amountXlm',
         'allocatedAt',
         'ledger',
         'txHash',
      ];
      for (const field of requiredFields) {
         const value = typedEvent[field as keyof LPAllocationSentEvent];
         if (value === undefined || value === null || value === '') {
            logger.warn(
               {
                  eventId: `${event.txHash}:${event.eventIndex}`,
                  missingField: field,
               },
               'Skipping LP allocation event due to missing required field'
            );
            return;
         }
      }

      const existing = await prisma.lpAllocation.findUnique({
         where: {
            txHash_eventIndex: {
               txHash: String(typedEvent.txHash),
               eventIndex: typedEvent.eventIndex,
            },
         },
         select: { id: true },
      });
      if (existing) {
         return;
      }

      await prisma.lpAllocation.create({
         data: {
            creatorId: typedEvent.creatorId,
            amountXlm: typedEvent.amountXlm,
            ledger: Number(typedEvent.ledger),
            txHash: String(typedEvent.txHash),
            eventIndex: typedEvent.eventIndex,
            allocatedAt: new Date(typedEvent.allocatedAt),
         },
      });

      await invalidateKeyLpStatsCache(typedEvent.creatorId);
      await invalidateLpOverviewCache();

      logger.info(
         {
            creatorId: typedEvent.creatorId,
            amountXlm: typedEvent.amountXlm,
            ledger: Number(typedEvent.ledger),
            txHash: String(typedEvent.txHash),
         },
         'LP allocation recorded'
      );
   });
}
