/**
 * Interface representing a minimal chain event for deduplication.
 */
export interface ChainEvent {
   /** Transaction hash (unique across the chain) */
   txHash: string;
   /** Index of the event within the transaction */
   eventIndex: number;
   /** Optional ledger/block number */
   ledger?: number;
   [key: string]: any;
}

/**
 * Dedupes a list of chain events based on transaction hash and event index.
 *
 * This ensures that if the same event is received multiple times in a batch
 * (e.g. due to overlapping ingestion windows), it is only processed once.
 *
 * @param events - The list of events to dedupe.
 * @returns A new array containing only unique events.
 */
export function dedupeChainEvents<T extends ChainEvent>(events: T[]): T[] {
   const seen = new Set<string>();
   return events.filter(event => {
      const key = `${event.txHash}:${event.eventIndex}`;
      if (seen.has(key)) {
         return false;
      }
      seen.add(key);
      return true;
   });
}

/**
 * Result returned by the per-event deduplication guard.
 */
export interface DedupeGuardResult {
   /** True when the event was already present in `seen` and was skipped. */
   skipped: boolean;
}

/**
 * Per-event deduplication guard.
 *
 * Checks a single chain event against a caller-maintained `seen` set.
 * If the `(txHash, eventIndex)` composite key is already in `seen` the
 * event is a duplicate and `{ skipped: true }` is returned without
 * mutating anything else. Otherwise the key is recorded in `seen` and
 * `{ skipped: false }` is returned so the caller can proceed to process
 * the event.
 *
 * @param event - The chain event to check.
 * @param seen  - Mutable Set that tracks already-processed composite keys.
 * @returns `{ skipped: true }` for duplicates, `{ skipped: false }` for new events.
 */
export function guardChainEvent(event: ChainEvent, seen: Set<string>): DedupeGuardResult {
   const key = `${event.txHash}:${event.eventIndex}`;
   if (seen.has(key)) {
      return { skipped: true };
   }
   seen.add(key);
   return { skipped: false };
}
