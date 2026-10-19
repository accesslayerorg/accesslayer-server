// src/modules/indexer/atomic-swap-indexer.service.ts
// Indexes SwapProposed, SwapExecuted, and SwapCancelled contract events into atomic_swaps table (#1087)

import { createHash } from 'crypto';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { buildLogFields } from '../../utils/log-fields.utils';
import {
   IndexerChainEvent,
   processIndexerChainEvents,
} from '../../utils/indexer-event-processor.utils';
import {
   dedupeChainEvents,
   guardChainEvent,
} from '../../utils/indexer-dedupe.utils';
import { updateIndexedLedger } from './ledger-gap-detection.service';

/** One hour in milliseconds (3600 seconds) */
export const DEFAULT_SWAP_EXPIRY_MS = 60 * 60 * 1000;

export interface SwapProposedEvent extends IndexerChainEvent {
   eventType: 'SwapProposed' | 'SWAP_PROPOSED' | 'swap_proposed';
   swapId?: string;
   swap_id?: string;
   id?: string;
   proposer?: string;
   proposerWallet?: string;
   proposer_wallet?: string;
   from?: string;
   actor?: string;
   counterparty?: string;
   counterpartyWallet?: string;
   counterparty_wallet?: string;
   to?: string;
   target?: string;
   offeredKey?: string;
   offered_key?: string;
   offeredKeyId?: string;
   offered_key_id?: string;
   offeredCreatorId?: string;
   offered_creator_id?: string;
   offeredAmount?: string | number;
   offered_amount?: string | number;
   offeredQuantity?: string | number;
   offered_quantity?: string | number;
   requestedKey?: string;
   requested_key?: string;
   requestedKeyId?: string;
   requested_key_id?: string;
   requestedCreatorId?: string;
   requested_creator_id?: string;
   requestedAmount?: string | number;
   requested_amount?: string | number;
   requestedQuantity?: string | number;
   requested_quantity?: string | number;
   expiresAt?: string | number | Date;
   expires_at?: string | number | Date;
   expiry?: string | number | Date;
   duration?: number;
   timestamp?: string | number | Date;
   proposedAt?: string | number | Date;
   proposed_at?: string | number | Date;
   occurredAt?: string | number | Date;
   ledgerClosedAt?: string;
}

export interface SwapExecutedEvent extends IndexerChainEvent {
   eventType: 'SwapExecuted' | 'SWAP_EXECUTED' | 'swap_executed';
   swapId?: string;
   swap_id?: string;
   id?: string;
   executor?: string;
   counterparty?: string;
   actor?: string;
   timestamp?: string | number | Date;
   executedAt?: string | number | Date;
   executed_at?: string | number | Date;
   occurredAt?: string | number | Date;
   ledgerClosedAt?: string;
}

export interface SwapCancelledEvent extends IndexerChainEvent {
   eventType: 'SwapCancelled' | 'SWAP_CANCELLED' | 'swap_cancelled';
   swapId?: string;
   swap_id?: string;
   id?: string;
   canceller?: string;
   proposer?: string;
   actor?: string;
   timestamp?: string | number | Date;
   cancelledAt?: string | number | Date;
   cancelled_at?: string | number | Date;
   occurredAt?: string | number | Date;
   ledgerClosedAt?: string;
}

export type AnySwapEvent =
   | SwapProposedEvent
   | SwapExecutedEvent
   | SwapCancelledEvent
   | IndexerChainEvent;

export const SWAP_EVENT_TYPES = new Set([
   'SwapProposed',
   'SWAP_PROPOSED',
   'swap_proposed',
   'SwapExecuted',
   'SWAP_EXECUTED',
   'swap_executed',
   'SwapCancelled',
   'SWAP_CANCELLED',
   'swap_cancelled',
]);

/**
 * Parses and validates an on-chain date/timestamp from various event field shapes.
 */
function parseTimestamp(raw: any, fallback: Date = new Date()): Date {
   if (!raw) return fallback;
   if (raw instanceof Date) return isNaN(raw.getTime()) ? fallback : raw;
   if (typeof raw === 'number') {
      if (raw < 10_000_000_000) {
         return new Date(raw * 1000);
      }
      return new Date(raw);
   }
   const parsed = new Date(raw);
   return isNaN(parsed.getTime()) ? fallback : parsed;
}

/**
 * Normalizes a raw SwapProposed event into strongly typed fields.
 */
export function normalizeSwapProposedEvent(event: Partial<SwapProposedEvent>): {
   swapId: string;
   proposer: string;
   counterparty: string;
   offeredKey: string;
   offeredAmount: string;
   requestedKey: string;
   requestedAmount: string;
   status: 'pending';
   expiresAt: Date;
   proposedAt: Date;
   ledger: number;
   txHash: string;
   eventIndex: number;
} | null {
   const swapId = String(
      event.swapId || event.swap_id || event.id || ''
   ).trim();
   const proposer = String(
      event.proposer ||
         event.proposerWallet ||
         event.proposer_wallet ||
         event.from ||
         event.actor ||
         ''
   ).trim();
   const counterparty = String(
      event.counterparty ||
         event.counterpartyWallet ||
         event.counterparty_wallet ||
         event.to ||
         event.target ||
         ''
   ).trim();
   const offeredKey = String(
      event.offeredKey ||
         event.offered_key ||
         event.offeredKeyId ||
         event.offered_key_id ||
         event.offeredCreatorId ||
         event.offered_creator_id ||
         ''
   ).trim();
   const rawOfferedAmount =
      event.offeredAmount ??
      event.offered_amount ??
      event.offeredQuantity ??
      event.offered_quantity;
   const offeredAmount =
      rawOfferedAmount !== undefined && rawOfferedAmount !== null
         ? String(rawOfferedAmount).trim()
         : '';

   const requestedKey = String(
      event.requestedKey ||
         event.requested_key ||
         event.requestedKeyId ||
         event.requested_key_id ||
         event.requestedCreatorId ||
         event.requested_creator_id ||
         ''
   ).trim();
   const rawRequestedAmount =
      event.requestedAmount ??
      event.requested_amount ??
      event.requestedQuantity ??
      event.requested_quantity;
   const requestedAmount =
      rawRequestedAmount !== undefined && rawRequestedAmount !== null
         ? String(rawRequestedAmount).trim()
         : '';

   const txHash = String(event.txHash || event.tx_hash || '').trim();
   const ledger =
      typeof event.ledger === 'number' ? event.ledger : Number(event.ledger);
   const eventIndex =
      typeof event.eventIndex === 'number'
         ? event.eventIndex
         : Number(event.event_index) || 0;

   if (
      !swapId ||
      !proposer ||
      !counterparty ||
      !offeredKey ||
      !offeredAmount ||
      !requestedKey ||
      !requestedAmount ||
      !txHash ||
      isNaN(ledger)
   ) {
      return null;
   }

   const proposedAt = parseTimestamp(
      event.timestamp ||
         event.proposedAt ||
         event.proposed_at ||
         event.occurredAt ||
         event.ledgerClosedAt
   );

   let expiresAt: Date;
   const rawExpiry =
      event.expiresAt || event.expires_at || event.expiry || event.duration;
   if (typeof rawExpiry === 'number') {
      if (rawExpiry <= 86400 * 365) {
         // duration in seconds
         expiresAt = new Date(proposedAt.getTime() + rawExpiry * 1000);
      } else if (rawExpiry < 10_000_000_000) {
         expiresAt = new Date(rawExpiry * 1000);
      } else {
         expiresAt = new Date(rawExpiry);
      }
   } else if (rawExpiry) {
      expiresAt = parseTimestamp(
         rawExpiry,
         new Date(proposedAt.getTime() + DEFAULT_SWAP_EXPIRY_MS)
      );
   } else {
      // Default: expires after 1h (#1087)
      expiresAt = new Date(proposedAt.getTime() + DEFAULT_SWAP_EXPIRY_MS);
   }

   return {
      swapId,
      proposer,
      counterparty,
      offeredKey,
      offeredAmount,
      requestedKey,
      requestedAmount,
      status: 'pending',
      expiresAt,
      proposedAt,
      ledger,
      txHash,
      eventIndex,
   };
}

/**
 * Normalizes a raw SwapExecuted event.
 */
export function normalizeSwapExecutedEvent(event: Partial<SwapExecutedEvent>): {
   swapId: string;
   ledger: number;
   txHash: string;
   executedAt: Date;
   eventIndex: number;
} | null {
   const swapId = String(
      event.swapId || event.swap_id || event.id || ''
   ).trim();
   const txHash = String(event.txHash || event.tx_hash || '').trim();
   const ledger =
      typeof event.ledger === 'number' ? event.ledger : Number(event.ledger);
   const eventIndex =
      typeof event.eventIndex === 'number'
         ? event.eventIndex
         : Number(event.event_index) || 0;

   if (!swapId || !txHash || isNaN(ledger)) {
      return null;
   }

   const executedAt = parseTimestamp(
      event.timestamp ||
         event.executedAt ||
         event.executed_at ||
         event.occurredAt ||
         event.ledgerClosedAt
   );

   return {
      swapId,
      ledger,
      txHash,
      executedAt,
      eventIndex,
   };
}

/**
 * Normalizes a raw SwapCancelled event.
 */
export function normalizeSwapCancelledEvent(
   event: Partial<SwapCancelledEvent>
): {
   swapId: string;
   ledger: number;
   txHash: string;
   cancelledAt: Date;
   eventIndex: number;
} | null {
   const swapId = String(
      event.swapId || event.swap_id || event.id || ''
   ).trim();
   const txHash = String(event.txHash || event.tx_hash || '').trim();
   const ledger =
      typeof event.ledger === 'number' ? event.ledger : Number(event.ledger);
   const eventIndex =
      typeof event.eventIndex === 'number'
         ? event.eventIndex
         : Number(event.event_index) || 0;

   if (!swapId || !txHash || isNaN(ledger)) {
      return null;
   }

   const cancelledAt = parseTimestamp(
      event.timestamp ||
         event.cancelledAt ||
         event.cancelled_at ||
         event.occurredAt ||
         event.ledgerClosedAt
   );

   return {
      swapId,
      ledger,
      txHash,
      cancelledAt,
      eventIndex,
   };
}

/**
 * Automatically marks all pending proposals whose expiry has passed as 'expired' (#1087).
 * Called on every index cycle and before fetching swap queries.
 *
 * @param db - Prisma client instance
 * @param asOf - Optional reference timestamp (defaults to current date/time)
 * @returns Total count of newly marked expired swaps
 */
export async function markExpiredSwaps(
   db: any = prisma,
   asOf: Date = new Date()
): Promise<number> {
   try {
      const result = await db.atomicSwap.updateMany({
         where: {
            status: 'pending',
            expiresAt: {
               lte: asOf,
            },
         },
         data: {
            status: 'expired',
         },
      });

      const count = result?.count ?? 0;
      if (count > 0) {
         logger.info(
            {
               type: 'swaps_marked_expired',
               expired_count: count,
               as_of: asOf.toISOString(),
            },
            'Expired swap proposals automatically marked on index cycle'
         );
      }
      return count;
   } catch (error) {
      logger.warn(
         { error, as_of: asOf.toISOString() },
         'Failed to mark expired swap proposals'
      );
      return 0;
   }
}

/**
 * Indexes a SwapProposed contract event.
 */
export async function processSwapProposedEvent(
   event: Partial<SwapProposedEvent>,
   db: any = prisma,
   seen?: Set<string>
): Promise<boolean> {
   const normalized = normalizeSwapProposedEvent(event);
   if (!normalized) {
      const missing: string[] = [];
      if (!event.swapId && !event.swap_id && !event.id) missing.push('swapId');
      if (
         !event.proposer &&
         !event.proposerWallet &&
         !event.proposer_wallet &&
         !event.from &&
         !event.actor
      )
         missing.push('proposer');
      if (
         !event.counterparty &&
         !event.counterpartyWallet &&
         !event.counterparty_wallet &&
         !event.to &&
         !event.target
      )
         missing.push('counterparty');
      if (
         !event.offeredKey &&
         !event.offered_key &&
         !event.offeredKeyId &&
         !event.offeredCreatorId
      )
         missing.push('offeredKey');
      if (
         event.offeredAmount === undefined &&
         event.offered_amount === undefined &&
         event.offeredQuantity === undefined
      )
         missing.push('offeredAmount');
      if (
         !event.requestedKey &&
         !event.requested_key &&
         !event.requestedKeyId &&
         !event.requestedCreatorId
      )
         missing.push('requestedKey');
      if (
         event.requestedAmount === undefined &&
         event.requested_amount === undefined &&
         event.requestedQuantity === undefined
      )
         missing.push('requestedAmount');
      if (typeof event.ledger !== 'number' || isNaN(event.ledger))
         missing.push('ledger');
      if (!event.txHash && !event.tx_hash) missing.push('txHash');

      logger.warn(
         buildLogFields({
            type: 'swap_proposed_skipped',
            missing_fields: missing,
            ledger: event.ledger,
            tx_hash: event.txHash || event.tx_hash,
         }),
         'Skipping SwapProposed event with missing required fields'
      );
      return false;
   }

   const {
      swapId,
      proposer,
      counterparty,
      offeredKey,
      offeredAmount,
      requestedKey,
      requestedAmount,
      status,
      expiresAt,
      proposedAt,
      ledger,
      txHash,
      eventIndex,
   } = normalized;

   if (seen) {
      const guardResult = guardChainEvent(
         {
            txHash,
            eventIndex,
            ledger,
         },
         seen
      );
      if (guardResult.skipped) {
         return false;
      }
   }

   // Idempotency check: don't overwrite existing proposal
   const existing = await db.atomicSwap.findUnique({
      where: { swapId },
      select: { id: true },
   });
   if (existing) {
      return false;
   }

   await db.atomicSwap.create({
      data: {
         swapId,
         proposer,
         counterparty,
         offeredKey,
         offeredAmount,
         requestedKey,
         requestedAmount,
         status,
         expiresAt,
         proposedAt,
         ledger,
         txHash,
      },
   });

   // Mark any expired swaps as of this event's timestamp
   await markExpiredSwaps(db, proposedAt);

   logger.info(
      buildLogFields({
         type: 'swap_proposed_indexed',
         swapId,
         proposer,
         counterparty,
         offeredKey,
         offeredAmount,
         requestedKey,
         requestedAmount,
         ledger,
         txHash,
         expiresAt: expiresAt.toISOString(),
      }),
      'Swap proposed event indexed'
   );

   return true;
}

/**
 * Indexes a SwapExecuted contract event.
 */
export async function processSwapExecutedEvent(
   event: Partial<SwapExecutedEvent>,
   db: any = prisma,
   seen?: Set<string>
): Promise<boolean> {
   const normalized = normalizeSwapExecutedEvent(event);
   if (!normalized) {
      const missing: string[] = [];
      if (!event.swapId && !event.swap_id && !event.id) missing.push('swapId');
      if (typeof event.ledger !== 'number' || isNaN(event.ledger))
         missing.push('ledger');
      if (!event.txHash && !event.tx_hash) missing.push('txHash');

      logger.warn(
         buildLogFields({
            type: 'swap_executed_skipped',
            missing_fields: missing,
            ledger: event.ledger,
            tx_hash: event.txHash || event.tx_hash,
         }),
         'Skipping SwapExecuted event with missing required fields'
      );
      return false;
   }

   const { swapId, ledger, txHash, executedAt, eventIndex } = normalized;

   if (seen) {
      const guardResult = guardChainEvent(
         {
            txHash,
            eventIndex,
            ledger,
         },
         seen
      );
      if (guardResult.skipped) {
         return false;
      }
   }

   const existing = await db.atomicSwap.findUnique({
      where: { swapId },
   });

   if (existing) {
      await db.atomicSwap.update({
         where: { swapId },
         data: {
            status: 'executed',
            executedAt,
         },
      });
   } else {
      // Upsert placeholder if execution event arrived ahead of proposal
      await db.atomicSwap.create({
         data: {
            swapId,
            proposer: 'unknown',
            counterparty: String(
               event.executor || event.counterparty || event.actor || 'unknown'
            ),
            offeredKey: 'unknown',
            offeredAmount: '0',
            requestedKey: 'unknown',
            requestedAmount: '0',
            status: 'executed',
            expiresAt: executedAt,
            proposedAt: executedAt,
            executedAt,
            ledger,
            txHash,
         },
      });
   }

   await markExpiredSwaps(db, executedAt);

   logger.info(
      buildLogFields({
         type: 'swap_executed_indexed',
         swapId,
         ledger,
         txHash,
         executedAt: executedAt.toISOString(),
      }),
      'Swap executed event indexed'
   );

   return true;
}

/**
 * Indexes a SwapCancelled contract event.
 */
export async function processSwapCancelledEvent(
   event: Partial<SwapCancelledEvent>,
   db: any = prisma,
   seen?: Set<string>
): Promise<boolean> {
   const normalized = normalizeSwapCancelledEvent(event);
   if (!normalized) {
      const missing: string[] = [];
      if (!event.swapId && !event.swap_id && !event.id) missing.push('swapId');
      if (typeof event.ledger !== 'number' || isNaN(event.ledger))
         missing.push('ledger');
      if (!event.txHash && !event.tx_hash) missing.push('txHash');

      logger.warn(
         buildLogFields({
            type: 'swap_cancelled_skipped',
            missing_fields: missing,
            ledger: event.ledger,
            tx_hash: event.txHash || event.tx_hash,
         }),
         'Skipping SwapCancelled event with missing required fields'
      );
      return false;
   }

   const { swapId, ledger, txHash, cancelledAt, eventIndex } = normalized;

   if (seen) {
      const guardResult = guardChainEvent(
         {
            txHash,
            eventIndex,
            ledger,
         },
         seen
      );
      if (guardResult.skipped) {
         return false;
      }
   }

   const existing = await db.atomicSwap.findUnique({
      where: { swapId },
   });

   if (existing) {
      await db.atomicSwap.update({
         where: { swapId },
         data: {
            status: 'cancelled',
            cancelledAt,
         },
      });
   } else {
      // Upsert placeholder if cancel event arrived ahead of proposal
      await db.atomicSwap.create({
         data: {
            swapId,
            proposer: String(
               event.canceller || event.proposer || event.actor || 'unknown'
            ),
            counterparty: 'unknown',
            offeredKey: 'unknown',
            offeredAmount: '0',
            requestedKey: 'unknown',
            requestedAmount: '0',
            status: 'cancelled',
            expiresAt: cancelledAt,
            proposedAt: cancelledAt,
            cancelledAt,
            ledger,
            txHash,
         },
      });
   }

   await markExpiredSwaps(db, cancelledAt);

   logger.info(
      buildLogFields({
         type: 'swap_cancelled_indexed',
         swapId,
         ledger,
         txHash,
         cancelledAt: cancelledAt.toISOString(),
      }),
      'Swap cancelled event indexed'
   );

   return true;
}

/**
 * Dispatches an event to the appropriate atomic swap event handler.
 */
export async function processAtomicSwapEvent(
   event: AnySwapEvent,
   db: any = prisma,
   seen?: Set<string>
): Promise<boolean> {
   const eventType = String(event.eventType || (event as any).event_type || '');

   if (
      eventType === 'SwapProposed' ||
      eventType === 'SWAP_PROPOSED' ||
      eventType === 'swap_proposed'
   ) {
      return processSwapProposedEvent(event as SwapProposedEvent, db, seen);
   }

   if (
      eventType === 'SwapExecuted' ||
      eventType === 'SWAP_EXECUTED' ||
      eventType === 'swap_executed'
   ) {
      return processSwapExecutedEvent(event as SwapExecutedEvent, db, seen);
   }

   if (
      eventType === 'SwapCancelled' ||
      eventType === 'SWAP_CANCELLED' ||
      eventType === 'swap_cancelled'
   ) {
      return processSwapCancelledEvent(event as SwapCancelledEvent, db, seen);
   }

   return false;
}

/**
 * Checkpoints the highest ledger sequence processed across an event batch.
 * Ensures contiguous indexing with no gaps (#1087).
 */
async function checkpointHighestLedger(
   events: IndexerChainEvent[]
): Promise<void> {
   const uniqueEvents = dedupeChainEvents(events);
   const processedLedgers = uniqueEvents
      .map(e => e.ledger)
      .filter((ledger): ledger is number => typeof ledger === 'number');

   if (processedLedgers.length === 0) {
      return;
   }

   const maxLedger = Math.max(...processedLedgers);
   const identifiers = uniqueEvents
      .map(e => `${e.txHash}:${e.eventIndex ?? 0}`)
      .sort()
      .join('|');
   const batchHash = createHash('sha256')
      .update(identifiers, 'utf8')
      .digest('hex')
      .slice(0, 16);

   await updateIndexedLedger(maxLedger, `${maxLedger}-000`, batchHash);
}

/**
 * Processes a batch of on-chain swap events with deduplication and ledger checkpointing.
 * On every cycle, expired proposals are automatically marked (#1087).
 */
export async function processSwapEvents(
   events: IndexerChainEvent[],
   db: any = prisma
): Promise<void> {
   const seen = new Set<string>();

   await processIndexerChainEvents(events, async event => {
      if (!SWAP_EVENT_TYPES.has(event.eventType)) {
         return;
      }
      await processAtomicSwapEvent(event, db, seen);
   });

   // Expired proposals automatically marked on next index cycle
   await markExpiredSwaps(db, new Date());

   // Checkpoint highest ledger to prevent gaps
   await checkpointHighestLedger(events);
}
