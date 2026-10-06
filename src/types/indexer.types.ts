/**
 * Indexer event types for chain event processing
 */

import { ChainEvent } from '../utils/indexer-dedupe.utils';

/**
 * Minimal chain event shape required for indexer processing and logging.
 */
export interface IndexerChainEvent extends ChainEvent {
   /** Domain event type (e.g. CREATOR_REGISTERED, KEY_BOUGHT). */
   eventType: string;
}
