// src/modules/indexer/tip-indexer.service.ts
//
// Indexes TipSent contract events into the `key_tips` /
// `key_tip_totals` tables (#1132).
//
// Guarantees:
// - Idempotent. Every event becomes a key_tips row with a unique
//   (txHash, eventIndex); a replayed event hits the constraint and its
//   total delta is skipped, so key_tip_totals never double-counts.
// - Atomic. The tip row and the running total are written in one
//   transaction, so the total can never drift from the tip log.
// - Nothing is silently dropped. A malformed event is moved to the
//   indexer DLQ.
// - Failures propagate, so the dispatcher does not advance the ledger
//   cursor past the batch and the batch is redelivered.
// - After every event, including replays, the key's cached tip
//   responses are invalidated.

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { moveToDLQ } from '../../utils/indexer-dlq.utils';
import { invalidateKeyTipsCache } from '../tips/tips.service';
import { stroopsToXlmDecimalString } from './reserve-indexer.service';

export const TIP_SENT_EVENT_TYPES: ReadonlySet<string> = new Set([
   'TIP_SENT',
   'TipSent',
   'tip',
]);

export const TIP_INDEXER_DLQ_JOB_TYPE = 'TIP_SENT';

export interface ParsedTipEvent {
   keyId: string;
   tipper: string;
   /** Amount in XLM (converted from stroops). */
   amountXlm: string;
   messageHash: string | null;
   tippedAt: Date;
   ledger: number;
   eventIndex: number;
   txHash: string;
}

export type TipParseResult =
   | { ok: true; value: ParsedTipEvent }
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

function readStringField(
   raw: Record<string, unknown>,
   ...names: string[]
): string | null {
   for (const name of names) {
      const value = raw[name];
      if (typeof value === 'string' && value.trim() !== '') {
         return value.trim();
      }
   }
   return null;
}

/** Pure validation of a raw event into a typed, persistable tip row. */
export function parseTipEvent(event: IndexerChainEvent): TipParseResult {
   const raw = event as Record<string, unknown>;

   const keyId = readStringField(
      raw,
      'creatorId',
      'creator_id',
      'keyId',
      'key_id',
      'creator'
   );
   if (!keyId) {
      return { ok: false, reason: 'missing or invalid key/creator id' };
   }

   const tipper = readStringField(raw, 'tipper', 'sender', 'wallet', 'actor');
   if (!tipper) {
      return { ok: false, reason: 'missing or invalid tipper' };
   }

   const amount = parseBigInt(raw.amount);
   if (amount === null || amount <= 0n) {
      return { ok: false, reason: 'missing or invalid amount' };
   }

   const messageHash =
      readStringField(raw, 'messageHash', 'message_hash', 'message_cid') ??
      null;

   const rawTippedAt =
      raw.tippedAt ?? raw.timestamp ?? raw.tradeAt ?? raw.createdAt;
   let tippedAt: Date | null = null;
   if (rawTippedAt !== undefined && rawTippedAt !== null) {
      const date = new Date(
         typeof rawTippedAt === 'number' ? rawTippedAt : String(rawTippedAt)
      );
      if (!Number.isNaN(date.getTime())) {
         tippedAt = date;
      }
   }
   if (!tippedAt) {
      tippedAt = new Date();
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
         tipper,
         amountXlm: stroopsToXlmDecimalString(amount),
         messageHash,
         tippedAt,
         ledger,
         eventIndex,
         txHash: event.txHash,
      },
   };
}

/**
 * Processes one TipSent event. Returns true when the tip was recorded,
 * false for replayed or malformed (DLQ'd) events.
 */
export async function processTipEvent(
   event: IndexerChainEvent
): Promise<boolean> {
   const eventId = `${event.txHash}:${event.eventIndex}`;
   const parsed = parseTipEvent(event);

   if (!parsed.ok) {
      logger.warn(
         { type: 'tip_event_rejected', eventId, reason: parsed.reason },
         'Malformed TipSent event moved to DLQ'
      );
      await moveToDLQ({
         jobType: TIP_INDEXER_DLQ_JOB_TYPE,
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

   // The tip row and the running total share one transaction: if the event
   // was already applied (P2002 on the unique constraint) the whole
   // transaction rolls back and the total is left untouched.
   let applied = false;
   try {
      await prisma.$transaction(async tx => {
         await tx.keyTip.create({
            data: {
               keyId: value.keyId,
               tipper: value.tipper,
               amount: value.amountXlm,
               messageHash: value.messageHash,
               ledger: value.ledger,
               txHash: value.txHash,
               eventIndex: value.eventIndex,
               tippedAt: value.tippedAt,
            },
         });

         await tx.keyTipTotal.upsert({
            where: { keyId: value.keyId },
            update: {
               total: { increment: value.amountXlm },
               count: { increment: 1 },
            },
            create: {
               keyId: value.keyId,
               total: value.amountXlm,
               count: 1,
            },
         });
         applied = true;
      });
   } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') {
         applied = false;
      } else {
         throw error;
      }
   }

   // Invalidate after every event, including replays, so a cache
   // populated from an older total is dropped.
   await invalidateKeyTipsCache(value.keyId);

   logger.debug(
      {
         type: applied ? 'tip_indexed' : 'tip_replay_skipped',
         eventId,
         key_id: value.keyId,
         tipper: value.tipper,
         amount_xlm: value.amountXlm,
      },
      applied ? 'TipSent event indexed' : 'Replayed TipSent event skipped'
   );
   return applied;
}

/**
 * Processes a batch of TipSent events in order; other events are ignored.
 * Cursor advancement belongs to the pipeline dispatcher.
 */
export async function processTipEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!TIP_SENT_EVENT_TYPES.has(event.eventType)) return;
      await processTipEvent(event);
   });
}
