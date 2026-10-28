// src/modules/indexer/treasury-indexer.service.ts
// Indexes FeeReceived and FundsAllocated treasury contract events (#1181).
//
// - FeeReceived appends a TreasuryInflow row and, only when that row is new,
//   increments the per-source TreasuryBalance in the same transaction. A
//   replayed event inserts nothing and therefore changes no balance.
// - FundsAllocated appends a TreasuryAllocation row. Allocations reduce the
//   total balance at read time.
// - Every write invalidates the treasury read cache.

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
   unitAmountSchema,
} from '../../utils/indexer-event-fields.utils';
import { invalidateTreasuryCache } from '../treasury/treasury.service';

export const FEE_RECEIVED_EVENT_TYPES = new Set([
   'FeeReceived',
   'FEE_RECEIVED',
]);
export const FUNDS_ALLOCATED_EVENT_TYPES = new Set([
   'FundsAllocated',
   'FUNDS_ALLOCATED',
]);
export const TREASURY_EVENT_TYPES = new Set([
   ...FEE_RECEIVED_EVENT_TYPES,
   ...FUNDS_ALLOCATED_EVENT_TYPES,
]);

const feeReceivedPayload = z.object({
   source: eventIdentifierSchema,
   amount: unitAmountSchema,
});

const fundsAllocatedPayload = z.object({
   destination: eventIdentifierSchema,
   amount: unitAmountSchema,
   purpose: z.string().max(1024).default(''),
});

/**
 * Applies a batch of treasury events in chain order. Each event is handled
 * exactly once per unique chain position; see the module comment above.
 */
export async function processTreasuryEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (FEE_RECEIVED_EVENT_TYPES.has(event.eventType)) {
         await recordFeeReceived(event);
         return;
      }
      if (FUNDS_ALLOCATED_EVENT_TYPES.has(event.eventType)) {
         await recordFundsAllocated(event);
      }
   });
}

async function recordFeeReceived(event: IndexerChainEvent): Promise<void> {
   const position = chainPositionSchema.safeParse(event);
   const payload = feeReceivedPayload.safeParse({
      source: event.source ?? event.payer,
      amount: event.amount,
   });
   if (!position.success || !payload.success) {
      logger.warn(
         {
            eventId: `${event.txHash}:${event.eventIndex}`,
            eventType: event.eventType,
         },
         'Skipping FeeReceived event with missing or invalid fields'
      );
      return;
   }

   const { source, amount } = payload.data;
   const row = {
      source,
      amount: amount.toString(),
      occurredAt: eventOccurredAt(event),
      ...position.data,
   };

   await prisma.$transaction(async tx => {
      const { count } = await tx.treasuryInflow.createMany({
         data: [row],
         skipDuplicates: true,
      });
      if (count === 0) {
         return;
      }
      await tx.treasuryBalance.upsert({
         where: { source },
         create: { source, balance: row.amount },
         update: { balance: { increment: row.amount } },
      });
   });

   await invalidateTreasuryCache();
}

async function recordFundsAllocated(event: IndexerChainEvent): Promise<void> {
   const position = chainPositionSchema.safeParse(event);
   const payload = fundsAllocatedPayload.safeParse({
      destination: event.destination ?? event.to,
      amount: event.amount,
      purpose: event.purpose,
   });
   if (!position.success || !payload.success) {
      logger.warn(
         {
            eventId: `${event.txHash}:${event.eventIndex}`,
            eventType: event.eventType,
         },
         'Skipping FundsAllocated event with missing or invalid fields'
      );
      return;
   }

   await prisma.treasuryAllocation.createMany({
      data: [
         {
            destination: payload.data.destination,
            amount: payload.data.amount.toString(),
            purpose: payload.data.purpose,
            occurredAt: eventOccurredAt(event),
            ...position.data,
         },
      ],
      skipDuplicates: true,
   });

   await invalidateTreasuryCache();
}
