// src/modules/indexer/key-cocreator-indexer.service.ts
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
   getChainEventId,
} from '../../utils/indexer-event-processor.utils';
import { invalidateCoCreatorCache } from '../keys/key-cocreator.service';

export interface CoCreatorAddedChainEvent extends IndexerChainEvent {
   eventType: 'CoCreatorAdded';
   keyId: string;
   wallet: string;
   role?: string;
}

export interface CoCreatorRemovedChainEvent extends IndexerChainEvent {
   eventType: 'CoCreatorRemoved';
   keyId: string;
   wallet: string;
}

export type KeyCoCreatorChainEvent =
   | CoCreatorAddedChainEvent
   | CoCreatorRemovedChainEvent;

export async function processKeyCoCreatorEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (
         event.eventType !== 'CoCreatorAdded' &&
         event.eventType !== 'CoCreatorRemoved'
      ) {
         return;
      }

      const coCreatorEvent = event as KeyCoCreatorChainEvent;
      const { keyId, wallet } = coCreatorEvent;

      if (!keyId || !wallet) {
         logger.warn(
            { eventId: getChainEventId(event) },
            'Skipping co-creator event with missing keyId or wallet'
         );
         return;
      }

      const timestamp = event.timestamp ? new Date(event.timestamp) : new Date();

      if (event.eventType === 'CoCreatorAdded') {
         const role = (event as CoCreatorAddedChainEvent).role || 'contributor';

         await prisma.keyCoCreator.upsert({
            where: {
               keyId_wallet: {
                  keyId,
                  wallet,
               },
            },
            create: {
               keyId,
               wallet,
               role,
               isActive: true,
               addedAt: timestamp,
               removedAt: null,
            },
            update: {
               role,
               isActive: true,
               addedAt: timestamp,
               removedAt: null,
            },
         });
      } else {
         // CoCreatorRemoved
         await prisma.keyCoCreator.updateMany({
            where: {
               keyId,
               wallet,
            },
            data: {
               isActive: false,
               removedAt: timestamp,
            },
         });
      }

      // Invalidate cache for this key and wallet
      await invalidateCoCreatorCache(keyId, wallet);
   });
}
