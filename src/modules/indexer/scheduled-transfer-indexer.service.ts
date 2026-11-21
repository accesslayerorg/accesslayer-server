import { z } from 'zod';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { moveToDLQ } from '../../utils/indexer-dlq.utils';
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
import { StellarAddressSchema } from '../wallet/wallet.schemas';

const statuses: Readonly<Record<string, 'pending' | 'claimed' | 'cancelled'>> = {
   transfer_scheduled: 'pending', TransferScheduled: 'pending', TRANSFER_SCHEDULED: 'pending',
   transfer_claimed: 'claimed', TransferClaimed: 'claimed', TRANSFER_CLAIMED: 'claimed',
   transfer_cancelled: 'cancelled', TransferCancelled: 'cancelled', TRANSFER_CANCELLED: 'cancelled',
};
export const SCHEDULED_TRANSFER_EVENT_TYPES: ReadonlySet<string> = new Set(Object.keys(statuses));

const transferIdentifierSchema = z.union([
   eventIdentifierSchema,
   z.number().int().nonnegative().safe(),
   z.bigint().nonnegative(),
]).transform((value, ctx) => {
   if (typeof value === 'string' && !/^\d+$/.test(value)) return value;
   const numeric = BigInt(value);
   if (numeric > 18446744073709551615n) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Transfer ID exceeds u64' });
      return z.NEVER;
   }
   return numeric.toString();
});

const positionSchema = chainPositionSchema.extend({
   ledger: z.number().int().nonnegative().max(2147483647),
   transferId: transferIdentifierSchema,
});
const scheduleSchema = z.object({
   sender: StellarAddressSchema,
   recipient: StellarAddressSchema,
   keyId: eventIdentifierSchema,
   amount: unitAmountSchema.refine(value => value > 0n).transform(value => value.toString()),
   releaseLedger: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
      .pipe(z.number().int().nonnegative().max(2147483647)),
});

function parseEvent(event: IndexerChainEvent) {
   const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
   const raw = { ...event, ...payload };
   const position = positionSchema.parse({
      txHash: event.txHash, eventIndex: event.eventIndex, ledger: event.ledger,
      transferId: raw.transferId ?? raw.transfer_id ?? raw.id,
   });
   if (!SCHEDULED_TRANSFER_EVENT_TYPES.has(event.eventType)) {
      throw new Error('Unsupported scheduled transfer event');
   }
   const status = statuses[event.eventType];
   const schedule = status === 'pending' ? scheduleSchema.parse({
      sender: raw.sender ?? raw.from,
      recipient: raw.recipient ?? raw.to,
      keyId: raw.keyId ?? raw.key_id,
      amount: raw.amount,
      releaseLedger: raw.releaseLedger ?? raw.release_ledger,
   }) : null;
   if (schedule && schedule.releaseLedger < position.ledger) {
      throw new Error('Release ledger precedes scheduling ledger');
   }
   return { ...position, status, schedule, occurredAt: eventOccurredAt(event) };
}

/** Event insertion and state change are atomic; replays roll back on the unique event key. */
export async function processScheduledTransferEvent(event: IndexerChainEvent): Promise<boolean> {
   let value: ReturnType<typeof parseEvent>;
   try {
      value = parseEvent(event);
   } catch (error) {
      logger.warn({ error, txHash: event.txHash, eventIndex: event.eventIndex }, 'Invalid scheduled transfer event');
      await moveToDLQ({
         jobType: 'SCHEDULED_TRANSFER',
         payload: JSON.parse(JSON.stringify(event, (_key, item) =>
            typeof item === 'bigint' ? item.toString() : item)),
         retryCount: 0, failureReason: 'Invalid scheduled transfer event',
      });
      return false;
   }
   try {
      await prisma.$transaction(async tx => {
         // Serializes events for one transfer, including terminal-before-schedule delivery.
         await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'scheduled-transfer:' + value.transferId}))`;
         await tx.scheduledTransferEvent.create({ data: {
            transferId: value.transferId, status: value.status,
            txHash: value.txHash, eventIndex: value.eventIndex,
            ledger: value.ledger, occurredAt: value.occurredAt,
         } });
         if (value.schedule) {
            await tx.scheduledTransfer.upsert({
               where: { id: value.transferId },
               create: {
                  id: value.transferId, ...value.schedule, status: 'pending',
                  scheduledLedger: value.ledger, scheduledAt: value.occurredAt,
               },
               update: {},
            });
         }
         // Schedules never reset terminal state. The journal also handles out-of-order delivery.
         const terminal = await tx.scheduledTransferEvent.findFirst({
            where: { transferId: value.transferId, status: { in: ['claimed', 'cancelled'] } },
            orderBy: [{ ledger: 'desc' }, { eventIndex: 'desc' }, { txHash: 'desc' }],
         });
         if (terminal) {
            await tx.scheduledTransfer.updateMany({
               where: { id: value.transferId },
               data: { status: terminal.status, completedAt: terminal.occurredAt },
            });
         }
      });
      return true;
   } catch (error) {
      if ((error as { code?: string }).code === 'P2002') return false;
      throw error;
   }
}

/** Shared pipeline owns cursor advancement after all event families succeed. */
export async function processScheduledTransferEvents(events: IndexerChainEvent[]): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (SCHEDULED_TRANSFER_EVENT_TYPES.has(event.eventType)) {
         await processScheduledTransferEvent(event);
      }
   });
}
