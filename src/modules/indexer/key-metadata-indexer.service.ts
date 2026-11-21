// src/modules/indexer/key-metadata-indexer.service.ts
/**
 * Indexes `MetadataUpdated` events emitted by creator key contracts (#986).
 *
 * Keeps the off-chain metadata cache synchronized with on-chain contract state.
 */

import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
   getChainEventId,
} from '../../utils/indexer-event-processor.utils';
import {
   handleMetadataUpdatedChainEvent,
} from '../keys/key-metadata-sync.service';

export interface ContractMetadataUpdatedEvent extends IndexerChainEvent {
   eventType: 'MetadataUpdated' | 'METADATA_UPDATED';
   keyAddress?: string;
   creatorId?: string;
   keyId?: string;
   name?: string;
   symbol?: string;
   description?: string;
   image_cid?: string;
}

/**
 * Applies MetadataUpdated events to the database and re-syncs the metadata cache.
 */
export async function processMetadataUpdatedEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async (event) => {
      if (
         event.eventType !== 'MetadataUpdated' &&
         event.eventType !== 'METADATA_UPDATED'
      ) {
         return;
      }

      const metaEvent = event as ContractMetadataUpdatedEvent;
      const keyId = metaEvent.keyAddress || metaEvent.creatorId || metaEvent.keyId;

      if (!keyId) {
         logger.warn(
            { eventId: getChainEventId(event) },
            'Skipping MetadataUpdated event with missing key identifier'
         );
         return;
      }

      await handleMetadataUpdatedChainEvent({
         eventType: metaEvent.eventType,
         keyAddress: metaEvent.keyAddress,
         creatorId: metaEvent.creatorId,
         keyId: metaEvent.keyId,
         name: metaEvent.name,
         symbol: metaEvent.symbol,
         description: metaEvent.description,
         image_cid: metaEvent.image_cid,
         txHash: event.txHash,
         ledger: event.ledger,
      });
   });
}
