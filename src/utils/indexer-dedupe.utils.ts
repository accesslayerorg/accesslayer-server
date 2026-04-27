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
  return events.filter((event) => {
    const key = `${event.txHash}:${event.eventIndex}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
