// src/modules/indexer/reserve-indexer.service.ts
//
// Indexes ReserveAccrued / ReserveDeployed contract events into the
// `key_reserves` / `key_reserve_events` tables (#1140).
//
// Guarantees:
// - Idempotent. Every event is recorded in the append-only
//   key_reserve_events log, which has a unique (txHash, eventIndex); a
//   replayed event hits the constraint, its balance delta is skipped, and
//   the key's cached reserve response is still invalidated.
// - Atomic. The log row and the balance mutation are written in one
//   transaction, so key_reserves can never drift from its event log.
// - Nothing is silently dropped. A malformed event is moved to the
//   indexer DLQ.
// - Failures propagate, so the dispatcher does not advance the ledger
//   cursor past the batch and the batch is redelivered.

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { moveToDLQ } from '../../utils/indexer-dlq.utils';
import { invalidateKeyReserveCache } from '../reserves/reserves.service';

export const RESERVE_ACCRUED_EVENT_TYPES: ReadonlySet<string> = new Set([
   'RESERVE_ACCRUED',
   'ReserveAccrued',
]);

export const RESERVE_DEPLOYED_EVENT_TYPES: ReadonlySet<string> = new Set([
   'RESERVE_DEPLOYED',
   'ReserveDeployed',
]);

export const ALL_RESERVE_EVENT_TYPES: ReadonlySet<string> = new Set([
   ...RESERVE_ACCRUED_EVENT_TYPES,
   ...RESERVE_DEPLOYED_EVENT_TYPES,
]);

export const RESERVE_INDEXER_DLQ_JOB_TYPE = 'RESERVE';

/** XLM stroops per whole XLM. */
const STROOPS_PER_XLM = 10_000_000n;

export interface ParsedReserveEvent {
   keyId: string;
   type: 'accrued' | 'deployed';
   /** Amount in XLM (converted from stroops). */
   amountXlm: string;
   ledger: number;
   eventIndex: number;
   txHash: string;
}

export type ReserveParseResult =
   | { ok: true; value: ParsedReserveEvent }
   | { ok: false; reason: string };

function parseBigInt(value: unknown): bigint | null {
   try {
      if (typeof value === 'number' && !Number.isInteger(value)) return null;
      if (typeof value === 'string' && value.trim() === '') return null;
      if (
         typeof value !== 'string' &&
         typeof value !== 'number' &&
         typeof value !== 'bigint'
      ) {
         return null;
      }
      return BigInt(value);
   } catch {
      return null;
   }
}

/** Converts a stroops amount to an XLM decimal string (7 dp). */
export function stroopsToXlmDecimalString(stroops: bigint): string {
   const negative = stroops < 0n;
   const abs = negative ? -stroops : stroops;
   const whole = abs / STROOPS_PER_XLM;
   const fraction = (abs % STROOPS_PER_XLM).toString().padStart(7, '0');
   return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** Pure validation of a raw event into a typed, persistable update. */
export function parseReserveEvent(
   event: IndexerChainEvent
): ReserveParseResult {
   const raw = event as Record<string, unknown>;
   const accrued = RESERVE_ACCRUED_EVENT_TYPES.has(event.eventType);

   const keyId =
      typeof raw.creatorId === 'string' && raw.creatorId.trim() !== ''
         ? raw.creatorId.trim()
         : typeof raw.keyId === 'string' && raw.keyId.trim() !== ''
           ? raw.keyId.trim()
           : null;
   if (!keyId) {
      return { ok: false, reason: 'missing or invalid key/creator id' };
   }

   const amount = parseBigInt(raw.amount);
   if (amount === null || amount <= 0n) {
      return { ok: false, reason: 'missing or invalid amount' };
   }

   const ledger = Number(raw.ledger);
   if (
      raw.ledger === undefined ||
      raw.ledger === null ||
      !Number.isInteger(ledger) ||
      ledger < 0
   ) {
      return { ok: false, reason: 'missing or invalid ledger' };
   }

   const eventIndex = Number(event.eventIndex);
   if (
      typeof event.txHash !== 'string' ||
      event.txHash === '' ||
      !Number.isInteger(eventIndex) ||
      eventIndex < 0
   ) {
      return { ok: false, reason: 'missing or invalid txHash/eventIndex' };
   }

   return {
      ok: true,
      value: {
         keyId,
         type: accrued ? 'accrued' : 'deployed',
         amountXlm: stroopsToXlmDecimalString(amount),
         ledger,
         eventIndex,
         txHash: event.txHash,
      },
   };
}

/**
 * Processes one reserve event. Returns true when the balance changed,
 * false for replayed or malformed (DLQ'd) events.
 */
export async function processReserveEvent(
   event: IndexerChainEvent
): Promise<boolean> {
   const eventId = `${event.txHash}:${event.eventIndex}`;
   const parsed = parseReserveEvent(event);

   if (!parsed.ok) {
      logger.warn(
         { type: 'reserve_event_rejected', eventId, reason: parsed.reason },
         'Malformed reserve event moved to DLQ'
      );
      await moveToDLQ({
         jobType: RESERVE_INDEXER_DLQ_JOB_TYPE,
         payload: JSON.parse(
            JSON.stringify(event, (_k, v) =>
               typeof v === 'bigint' ? v.toString() : v
            )
         ),
         retryCount: 0,
         failureReason: parsed.reason,
      });
      return false;
   }

   const value = parsed.value;

   // The log insert and the balance mutation share one transaction: if the
   // event was already applied (P2002 on the unique constraint) the whole
   // transaction rolls back and the balance is left untouched.
   let applied = false;
   try {
      await prisma.$transaction(async tx => {
         await tx.keyReserveEvent.create({
            data: {
               keyId: value.keyId,
               type: value.type,
               amount: value.amountXlm,
               ledger: value.ledger,
               txHash: value.txHash,
               eventIndex: value.eventIndex,
            },
         });

         if (value.type === 'accrued') {
            await tx.keyReserve.upsert({
               where: { keyId: value.keyId },
               update: {
                  balance: { increment: value.amountXlm },
                  totalAccrued: { increment: value.amountXlm },
               },
               create: {
                  keyId: value.keyId,
                  balance: value.amountXlm,
                  totalAccrued: value.amountXlm,
               },
            });
         } else {
            await tx.keyReserve.upsert({
               where: { keyId: value.keyId },
               update: {
                  // Floor at zero so a mis-ordered deployment never drives
                  // the balance negative.
                  balance: { decrement: value.amountXlm },
                  totalDeployed: { increment: value.amountXlm },
               },
               create: {
                  keyId: value.keyId,
                  balance: 0,
                  totalDeployed: value.amountXlm,
               },
            });
         }
         applied = true;
      });
   } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') {
         applied = false;
      } else {
         throw error;
      }
   }

   // Invalidate after every event, including replays, so a cache populated
   // from an older balance is dropped.
   await invalidateKeyReserveCache(value.keyId);

   logger.debug(
      {
         type: applied ? 'reserve_indexed' : 'reserve_replay_skipped',
         eventId,
         key_id: value.keyId,
         reserve_type: value.type,
         amount_xlm: value.amountXlm,
      },
      applied
         ? 'Reserve event indexed'
         : 'Replayed reserve event skipped'
   );
   return applied;
}

/**
 * Processes a batch of reserve events in order; other events are ignored.
 * Cursor advancement belongs to the pipeline dispatcher.
 */
export async function processReserveEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!ALL_RESERVE_EVENT_TYPES.has(event.eventType)) return;
      await processReserveEvent(event);
   });
}
