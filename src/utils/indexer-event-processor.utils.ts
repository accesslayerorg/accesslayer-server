import { logger } from './logger.utils';
import { buildLogFields } from './log-fields.utils';
import { dedupeChainEvents, ChainEvent } from './indexer-dedupe.utils';
import { elapsedMs, startTimer } from './monotonic-clock.utils';

/**
 * Minimal chain event shape required for indexer processing and logging.
 */
export interface IndexerChainEvent extends ChainEvent {
   /** Domain event type (e.g. CREATOR_REGISTERED, KEY_BOUGHT). */
   eventType: string;
}

/**
 * Stable identifier for a chain event, used for deduplication and log correlation.
 */
export function getChainEventId(event: ChainEvent): string {
   return `${event.txHash}:${event.eventIndex}`;
}

/**
 * Processes a single chain event with timing and structured logging.
 *
 * Emits exactly one info-level log after the handler completes successfully.
 * Latency is measured from the start of processing to completion using a
 * monotonic clock.
 */
export async function processIndexerChainEvent<T extends IndexerChainEvent>(
   event: T,
   handler: (event: T) => Promise<void>
): Promise<void> {
   const timer = startTimer();
   const eventId = getChainEventId(event);

   await handler(event);

   logger.info(
      buildLogFields({
         type: 'indexer_event_processed',
         eventType: event.eventType,
         eventId,
         txHash: event.txHash,
         eventIndex: event.eventIndex,
         ledger: event.ledger,
         elapsedMs: elapsedMs(timer),
      }),
      'Indexer chain event processed'
   );
}

/**
 * Ledger range covered by a batch of chain events, derived from the
 * `ledger` field present on each event.
 */
interface BatchLedgerRange {
   fromLedger: number | undefined;
   toLedger: number | undefined;
}

/**
 * Derives the ledger range (min/max) covered by a batch of chain events.
 *
 * Events without a `ledger` value are ignored. If no event in the batch
 * has a `ledger`, both bounds are `undefined`.
 */
function getBatchLedgerRange<T extends ChainEvent>(
   events: T[]
): BatchLedgerRange {
   const ledgers = events
      .map(event => event.ledger)
      .filter((ledger): ledger is number => typeof ledger === 'number');

   if (ledgers.length === 0) {
      return { fromLedger: undefined, toLedger: undefined };
   }

   return {
      fromLedger: Math.min(...ledgers),
      toLedger: Math.max(...ledgers),
   };
}

/**
 * Dedupes a batch of chain events and processes each unique event sequentially.
 *
 * Each event emits one structured log entry via {@link processIndexerChainEvent}.
 *
 * The batch itself also emits exactly two structured logs:
 * - An info-level log when the batch starts, with the ledger range and
 *   the size of the incoming batch (before deduplication).
 * - A debug-level log when the batch completes, with the ledger range,
 *   the number of unique events actually processed, and the wall-clock
 *   duration of the whole batch.
 */
export async function processIndexerChainEvents<T extends IndexerChainEvent>(
   events: T[],
   handler: (event: T) => Promise<void>
): Promise<void> {
   const { fromLedger, toLedger } = getBatchLedgerRange(events);
   const batchTimer = startTimer();

   logger.info(
      {
         type: 'indexer_batch_started',
         from_ledger: fromLedger,
         to_ledger: toLedger,
         batch_size: events.length,
      },
      'Indexer batch started'
   );

   const uniqueEvents = dedupeChainEvents(events);

   for (const event of uniqueEvents) {
      await processIndexerChainEvent(event, handler);
   }

   logger.debug(
      {
         type: 'indexer_batch_completed',
         from_ledger: fromLedger,
         to_ledger: toLedger,
         events_processed: uniqueEvents.length,
         duration_ms: elapsedMs(batchTimer),
      },
      'Indexer batch completed'
   );
}

export interface CheckpointCallbacks {
   /** Called after all events for a ledger are processed. Receives the ledger sequence, last event index, and event IDs. */
   onLedgerComplete: (
      ledger: number,
      lastEventIndex: number,
      eventIds: string[]
   ) => Promise<void>;
}

/**
 * Dedupes, groups by ledger, and processes events sequentially.
 *
 * After all events for a ledger are processed, calls `onLedgerComplete`
 * so the caller can write a checkpoint atomically.
 *
 * Events without a `ledger` field are processed but not checkpointed.
 */
export async function processIndexerChainEventsWithCheckpointing<
   T extends IndexerChainEvent,
>(
   events: T[],
   handler: (event: T) => Promise<void>,
   callbacks: CheckpointCallbacks
): Promise<void> {
   const uniqueEvents = dedupeChainEvents(events);

   // Group events by ledger
   const byLedger = new Map<number, T[]>();
   const noLedger: T[] = [];

   for (const event of uniqueEvents) {
      if (event.ledger !== undefined) {
         const group = byLedger.get(event.ledger) || [];
         group.push(event);
         byLedger.set(event.ledger, group);
      } else {
         noLedger.push(event);
      }
   }

   // Process events without a ledger first (no checkpoint possible)
   for (const event of noLedger) {
      await processIndexerChainEvent(event, handler);
   }

   // Process each ledger group
   const sortedLedgers = [...byLedger.keys()].sort((a, b) => a - b);

   for (const ledger of sortedLedgers) {
      const ledgerEvents = byLedger.get(ledger)!;
      const eventIds: string[] = [];

      for (const event of ledgerEvents) {
         await processIndexerChainEvent(event, handler);
         eventIds.push(getChainEventId(event));
      }

      // Checkpoint after all events for this ledger are processed
      const lastEventIndex = ledgerEvents[ledgerEvents.length - 1].eventIndex;
      await callbacks.onLedgerComplete(ledger, lastEventIndex, eventIds);
   }
}
