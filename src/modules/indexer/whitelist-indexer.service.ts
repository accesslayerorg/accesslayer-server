import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { invalidateWhitelistCache } from '../whitelist/whitelist.service';

/**
 * Chain events emitted by the key contract when a creator changes the
 * early-access whitelist.
 */
export interface WhitelistChainEvent extends IndexerChainEvent {
   eventType: 'WHITELIST_ADDED' | 'WHITELIST_REMOVED';
   /** Creator profile id the whitelist belongs to. */
   creatorId: string;
   /** Wallets added or removed by this event. */
   wallets: string[];
}

/**
 * Applies WHITELIST_ADDED / WHITELIST_REMOVED events to the database so it
 * mirrors on-chain state. Both operations are idempotent, so replaying a
 * batch (or an API write that already applied the change) is harmless.
 */
export async function processWhitelistEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (
         event.eventType !== 'WHITELIST_ADDED' &&
         event.eventType !== 'WHITELIST_REMOVED'
      ) {
         return;
      }

      const { creatorId, wallets } = event as WhitelistChainEvent;
      if (!creatorId || !Array.isArray(wallets) || wallets.length === 0) {
         logger.warn(
            { eventId: `${event.txHash}:${event.eventIndex}` },
            'Skipping whitelist event with missing creatorId or wallets'
         );
         return;
      }

      if (event.eventType === 'WHITELIST_ADDED') {
         const creator = await prisma.creatorProfile.findUnique({
            where: { id: creatorId },
            select: { id: true },
         });
         if (!creator) {
            logger.warn(
               { creatorId, txHash: event.txHash },
               'Skipping whitelist add for unknown creator'
            );
            return;
         }
         await prisma.whitelist.createMany({
            data: wallets.map(address => ({ address, creatorId })),
            skipDuplicates: true,
         });
      } else {
         await prisma.whitelist.deleteMany({
            where: { creatorId, address: { in: wallets } },
         });
      }

      await invalidateWhitelistCache(creatorId);
   });
}
