// src/modules/indexer/early-incentive-indexer.service.ts
// Indexes EarlySlotFilled contract events (#1180). Each event is appended to
// invoice_early_slot_events once per chain position; replays are no-ops. The
// read model derives slots filled from that log.

import { z } from 'zod';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   IndexerChainEvent,
   processIndexerChainEvents,
} from '../../utils/indexer-event-processor.utils';
import {
   chainPositionSchema,
   eventIdentifierSchema,
   eventOccurredAt,
} from '../../utils/indexer-event-fields.utils';
import { invalidateEarlyIncentiveCache } from '../invoice/invoice-early-incentive.service';

export const EARLY_SLOT_FILLED_EVENT_TYPES = new Set([
   'EarlySlotFilled',
   'EARLY_SLOT_FILLED',
]);

const earlySlotFilledPayload = z.object({
   invoiceId: eventIdentifierSchema,
   slotsTotal: z.number().int().min(1).max(1_000_000),
   bonusBps: z.number().int().min(0).max(10_000),
   investor: eventIdentifierSchema.nullable().optional(),
});

export async function processEarlySlotFilledEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!EARLY_SLOT_FILLED_EVENT_TYPES.has(event.eventType)) {
         return;
      }

      const position = chainPositionSchema.safeParse(event);
      const payload = earlySlotFilledPayload.safeParse({
         invoiceId: event.invoice_id ?? event.invoiceId,
         slotsTotal: event.slots_total ?? event.slotsTotal,
         bonusBps: event.bonus_bps ?? event.bonusBps,
         investor: event.investor ?? event.actor,
      });
      if (!position.success || !payload.success) {
         logger.warn(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
               eventType: event.eventType,
            },
            'Skipping EarlySlotFilled event with missing or invalid fields'
         );
         return;
      }

      await prisma.invoiceEarlySlotEvent.createMany({
         data: [
            {
               invoiceId: payload.data.invoiceId,
               slotsTotal: payload.data.slotsTotal,
               bonusBps: payload.data.bonusBps,
               investor: payload.data.investor ?? null,
               occurredAt: eventOccurredAt(event),
               ...position.data,
            },
         ],
         skipDuplicates: true,
      });

      await invalidateEarlyIncentiveCache(payload.data.invoiceId);
   });
}
