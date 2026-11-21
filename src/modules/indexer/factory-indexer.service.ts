// src/modules/indexer/factory-indexer.service.ts
//
// Key factory deployment event indexing (#983): KeyDeployed contract events
// insert a FactoryDeployedKey row into the factory registry. contractAddress
// is itself unique (a re-deploy replay is naturally idempotent), but the
// standard (txHash, eventIndex) unique-constraint + P2002-catch pattern is
// still followed for consistency with the rest of the indexer suite.

import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { buildLogFields } from '../../utils/log-fields.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';

export interface KeyDeployedChainEvent extends IndexerChainEvent {
   eventType: 'KEY_DEPLOYED';
   contractAddress: string;
   creatorWallet: string;
   keyId?: string;
   deployedAt: string;
}

function isValidEvent(
   event: IndexerChainEvent
): event is KeyDeployedChainEvent {
   const e = event as Partial<KeyDeployedChainEvent>;
   return (
      event.eventType === 'KEY_DEPLOYED' &&
      typeof e.contractAddress === 'string' &&
      e.contractAddress.length > 0 &&
      typeof e.creatorWallet === 'string' &&
      e.creatorWallet.length > 0 &&
      typeof e.deployedAt === 'string' &&
      !isNaN(new Date(e.deployedAt).getTime())
   );
}

/**
 * Applies KEY_DEPLOYED events to the FactoryDeployedKey registry.
 */
export async function processFactoryEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (event.eventType !== 'KEY_DEPLOYED') {
         return;
      }

      if (!isValidEvent(event)) {
         logger.warn(
            buildLogFields({
               type: 'factory_event_invalid',
               eventId: `${event.txHash}:${event.eventIndex}`,
            }),
            'Skipping factory event with missing or invalid fields'
         );
         return;
      }

      const { contractAddress, creatorWallet, keyId, deployedAt } = event;

      try {
         await prisma.$transaction(async tx => {
            await tx.factoryDeployedKey.create({
               data: {
                  contractAddress,
                  creatorWallet,
                  keyId: keyId ?? null,
                  deployedAt: new Date(deployedAt),
                  txHash: String(event.txHash),
                  eventIndex: Number(event.eventIndex),
               },
            });
         });
      } catch (error) {
         if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
         ) {
            logger.debug(
               { eventId: `${event.txHash}:${event.eventIndex}` },
               'Factory deployment event already applied; skipping replay'
            );
            return;
         }
         throw error;
      }
   });
}
