// src/modules/indexer/instalment-schedule-indexer.service.ts
// Indexes InstalmentPaid contract events into instalment_payments (#1177).
// Each event is idempotent by chain position (txHash + eventIndex) and
// invalidates the 60s invoice schedule cache.

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
import { invalidateInvoiceScheduleCache } from '../invoice/invoice-schedule.service';

export const INSTALMENT_PAID_EVENT_TYPES: ReadonlySet<string> = new Set([
   'InstalmentPaid',
   'INSTALMENT_PAID',
]);

const instalmentPaidPayload = z.object({
   invoiceId: eventIdentifierSchema,
   instalmentNumber: z.coerce.number().int().min(1).max(10_000),
   totalInstalments: z.coerce.number().int().min(1).max(10_000).optional(),
   amount: z.union([z.string().min(1), z.number().positive(), z.bigint()]),
   payer: eventIdentifierSchema.nullable().optional(),
});

function parseOptionalDate(raw: unknown): Date | null {
   if (raw === undefined || raw === null || raw === '') return null;
   const numeric =
      typeof raw === 'number' ||
      typeof raw === 'bigint' ||
      (typeof raw === 'string' && /^\d+$/.test(raw));
   const date = numeric
      ? new Date(Number(raw) * 1000)
      : new Date(String(raw));
   return Number.isNaN(date.getTime()) ? null : date;
}

export async function processInstalmentPaidEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!INSTALMENT_PAID_EVENT_TYPES.has(event.eventType)) {
         return;
      }

      const raw = event as Record<string, unknown>;
      const position = chainPositionSchema.safeParse(event);
      const payload = instalmentPaidPayload.safeParse({
         invoiceId: raw.invoice_id ?? raw.invoiceId,
         instalmentNumber:
            raw.instalment_number ??
            raw.instalmentNumber ??
            raw.instalment_index ??
            raw.index ??
            1,
         totalInstalments:
            raw.total_instalments ?? raw.totalInstalments ?? undefined,
         amount: raw.amount,
         payer: raw.payer ?? raw.actor ?? raw.wallet,
      });

      if (!position.success || !payload.success) {
         logger.warn(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
               eventType: event.eventType,
            },
            'Skipping InstalmentPaid event with missing or invalid fields'
         );
         return;
      }

      // Idempotency check by (txHash, eventIndex).
      const existingByTx = await prisma.instalmentPayment.findUnique({
         where: {
            txHash_eventIndex: {
               txHash: position.data.txHash,
               eventIndex: position.data.eventIndex,
            },
         },
         select: { id: true },
      });

      if (existingByTx) {
         await invalidateInvoiceScheduleCache(payload.data.invoiceId);
         return;
      }

      const occurredAt = eventOccurredAt(event);
      const paidAt =
         parseOptionalDate(raw.paid_at ?? raw.paidAt) ?? occurredAt;
      const dueDate =
         parseOptionalDate(raw.due_date ?? raw.dueDate) ?? occurredAt;
      const amountStr = String(payload.data.amount);

      await prisma.instalmentPayment.upsert({
         where: {
            invoiceId_instalmentNumber: {
               invoiceId: payload.data.invoiceId,
               instalmentNumber: payload.data.instalmentNumber,
            },
         },
         update: {
            amount: amountStr,
            paidAt,
            payer: payload.data.payer ?? null,
            txHash: position.data.txHash,
            eventIndex: position.data.eventIndex,
            ledger: position.data.ledger,
            ...(payload.data.totalInstalments !== undefined
               ? { totalInstalments: payload.data.totalInstalments }
               : {}),
         },
         create: {
            invoiceId: payload.data.invoiceId,
            instalmentNumber: payload.data.instalmentNumber,
            totalInstalments: payload.data.totalInstalments ?? null,
            amount: amountStr,
            dueDate,
            paidAt,
            payer: payload.data.payer ?? null,
            txHash: position.data.txHash,
            eventIndex: position.data.eventIndex,
            ledger: position.data.ledger,
         },
      });

      await invalidateInvoiceScheduleCache(payload.data.invoiceId);
   });
}
