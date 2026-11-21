// src/modules/indexer/key-deprecation-indexer.service.ts
// Indexes KEY_DEPRECATED events emitted by the key contract, mirroring
// on-chain deprecation onto CreatorProfile so GET /keys/:keyId/deprecation,
// the key list/search endpoints, and the notification feed reflect it.

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
   getChainEventId,
} from '../../utils/indexer-event-processor.utils';
import { invalidateCreatorDashboardCache } from '../creator/creator-dashboard.service';
import { dispatchKeyDeprecationNotifications } from '../keys/key-deprecation.service';

/**
 * Chain event emitted by the key contract when a creator's key is marked
 * deprecated, optionally naming a successor key.
 */
export interface KeyDeprecationChainEvent extends IndexerChainEvent {
   eventType: 'KEY_DEPRECATED';
   /** Creator profile id (key id) the event applies to. */
   creatorId: string;
   /** Human-readable reason for the deprecation, if provided on-chain. */
   reason?: string;
   /** Creator profile id of the designated successor key, if any. */
   successorKeyId?: string;
}

/**
 * Applies KEY_DEPRECATED events to the database. Idempotent: once a key is
 * already marked deprecated (whether by this indexer or the admin buyback
 * flow), a replayed event is a no-op — no duplicate DB writes and no
 * duplicate holder notifications.
 */
export async function processKeyDeprecationEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (event.eventType !== 'KEY_DEPRECATED') {
         return;
      }

      const { creatorId, reason, successorKeyId } =
         event as KeyDeprecationChainEvent;
      if (!creatorId) {
         logger.warn(
            { eventId: getChainEventId(event) },
            'Skipping key deprecation event with missing creatorId'
         );
         return;
      }

      const creator = await prisma.creatorProfile.findUnique({
         where: { id: creatorId },
         select: { id: true, deprecatedAt: true },
      });
      if (!creator) {
         logger.warn(
            { creatorId, txHash: event.txHash },
            'Skipping key deprecation event for unknown creator'
         );
         return;
      }

      if (creator.deprecatedAt) {
         // Already deprecated — replayed event or superseded by the admin
         // buyback flow. Skip the write and the notification dispatch.
         return;
      }

      let resolvedSuccessorKeyId: string | null = null;
      if (successorKeyId) {
         const successor = await prisma.creatorProfile.findUnique({
            where: { id: successorKeyId },
            select: { id: true },
         });
         if (successor) {
            resolvedSuccessorKeyId = successor.id;
         } else {
            logger.warn(
               { creatorId, successorKeyId },
               'Successor key referenced by deprecation event not found; storing without successor'
            );
         }
      }

      await prisma.creatorProfile.update({
         where: { id: creator.id },
         data: {
            deprecatedAt: new Date(),
            reason: reason ?? null,
            successorKeyId: resolvedSuccessorKeyId,
         },
      });

      await invalidateCreatorDashboardCache(creator.id);

      await dispatchKeyDeprecationNotifications({
         keyId: creator.id,
         eventId: getChainEventId(event),
         reason,
         successorKeyId: resolvedSuccessorKeyId ?? undefined,
      });
   });
}
