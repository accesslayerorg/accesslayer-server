// src/modules/indexer/key-gate-config-indexer.service.ts
// Indexes key gate configuration change events (#1150).

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { cacheInvalidate } from '../../utils/redis.utils';
import { keyGateConfigRedisKey } from '../../constants/redis.constants';

export const GATE_CONFIG_UPDATED_EVENT_TYPES = [
   'GATE_CONFIG_UPDATED',
   'GateConfigUpdated',
   'GATE_CONFIG_CHANGED',
   'GateConfigChanged',
   'KEY_GATE_CONFIG_UPDATED',
];

export interface GateConfigUpdatedEvent extends IndexerChainEvent {
   eventType:
      | 'GATE_CONFIG_UPDATED'
      | 'GateConfigUpdated'
      | 'GATE_CONFIG_CHANGED'
      | 'GateConfigChanged'
      | 'KEY_GATE_CONFIG_UPDATED';
   keyId: string;
}

/**
 * Processes gate configuration change events.
 * Invalidates cache for the affected key.
 */
export async function processGateConfigEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!GATE_CONFIG_UPDATED_EVENT_TYPES.includes(event.eventType)) {
         return;
      }

      const typedEvent = event as GateConfigUpdatedEvent;
      const keyId = String(typedEvent.keyId || typedEvent['creatorId'] || '');

      if (!keyId) {
         logger.warn(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
            },
            'Skipping gate config event: missing keyId'
         );
         return;
      }

      const profile = await prisma.creatorProfile.findFirst({
         where: {
            OR: [{ id: keyId }, { handle: keyId }],
         },
         select: { id: true },
      });

      if (!profile) {
         logger.warn(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
               keyId,
            },
            'Gate config event references unknown key; skipping'
         );
         return;
      }

      await cacheInvalidate(keyGateConfigRedisKey(profile.id));

      logger.info(
         {
            eventType: event.eventType,
            keyId: profile.id,
            txHash: event.txHash,
            ledger: event.ledger,
         },
         'Key gate config cache invalidated from contract event'
      );
   });
}
