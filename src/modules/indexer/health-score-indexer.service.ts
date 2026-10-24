// src/modules/indexer/health-score-indexer.service.ts
// HealthScoreUpdated contract events (#1178). The score itself is read live
// from the contract, so the indexer's only job is to drop the cached score for
// the affected wallet so the next read fetches the new value.

import { z } from 'zod';
import { logger } from '../../utils/logger.utils';
import {
   IndexerChainEvent,
   processIndexerChainEvents,
} from '../../utils/indexer-event-processor.utils';
import { eventIdentifierSchema } from '../../utils/indexer-event-fields.utils';
import { invalidateHealthScoreCache } from '../portfolio/portfolio-health-score.service';

export const HEALTH_SCORE_UPDATED_EVENT_TYPES = new Set([
   'HealthScoreUpdated',
   'HEALTH_SCORE_UPDATED',
]);

const healthScoreUpdatedPayload = z.object({
   wallet: eventIdentifierSchema,
});

export async function processHealthScoreEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!HEALTH_SCORE_UPDATED_EVENT_TYPES.has(event.eventType)) {
         return;
      }

      const payload = healthScoreUpdatedPayload.safeParse({
         wallet: event.wallet ?? event.investor ?? event.actor,
      });
      if (!payload.success) {
         logger.warn(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
               eventType: event.eventType,
            },
            'Skipping HealthScoreUpdated event without a wallet'
         );
         return;
      }

      await invalidateHealthScoreCache(payload.data.wallet);
   });
}
