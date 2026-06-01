import { logger } from './logger.utils';
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
    {
      type: 'indexer_event_processed',
      eventType: event.eventType,
      eventId,
      txHash: event.txHash,
      eventIndex: event.eventIndex,
      ledger: event.ledger,
      elapsedMs: elapsedMs(timer),
    },
    'Indexer chain event processed'
  );
}

/**
 * Dedupes a batch of chain events and processes each unique event sequentially.
 *
 * Each event emits one structured log entry via {@link processIndexerChainEvent}.
 */
export async function processIndexerChainEvents<T extends IndexerChainEvent>(
  events: T[],
  handler: (event: T) => Promise<void>
): Promise<void> {
  const uniqueEvents = dedupeChainEvents(events);

  for (const event of uniqueEvents) {
    await processIndexerChainEvent(event, handler);
  }
}
