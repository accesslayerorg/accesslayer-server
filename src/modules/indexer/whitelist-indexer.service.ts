import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import {
   invalidateWhitelistCache,
   resolveCreatorId,
} from '../whitelist/whitelist.service';

/**
 * Event types for on-chain whitelist modifications.
 */
export const WHITELIST_ADD_EVENT_TYPES = new Set([
   'WalletWhitelisted',
   'WALLET_WHITELISTED',
   'WHITELIST_ADDED',
]);

export const WHITELIST_REMOVE_EVENT_TYPES = new Set([
   'WalletRemovedFromWhitelist',
   'WALLET_REMOVED_FROM_WHITELIST',
   'WHITELIST_REMOVED',
]);

export const ALL_WHITELIST_EVENT_TYPES = new Set([
   ...WHITELIST_ADD_EVENT_TYPES,
   ...WHITELIST_REMOVE_EVENT_TYPES,
]);

/**
 * Chain events emitted by the key contract when a creator changes the
 * early-access whitelist.
 */
export interface WhitelistChainEvent extends IndexerChainEvent {
   eventType:
      | 'WalletWhitelisted'
      | 'WALLET_WHITELISTED'
      | 'WHITELIST_ADDED'
      | 'WalletRemovedFromWhitelist'
      | 'WALLET_REMOVED_FROM_WHITELIST'
      | 'WHITELIST_REMOVED';
   /** Creator profile id the whitelist belongs to. */
   creatorId?: string;
   keyId?: string;
   keyAddress?: string;
   /** Wallets added or removed by this event. */
   wallets?: string[];
   wallet?: string;
   actor?: string;
}

/**
 * Extracts normalized wallets list from chain event.
 */
function extractWallets(event: any): string[] {
   if (Array.isArray(event.wallets) && event.wallets.length > 0) {
      return event.wallets;
   }
   if (typeof event.wallet === 'string' && event.wallet.length > 0) {
      return [event.wallet];
   }
   if (typeof event.actor === 'string' && event.actor.length > 0) {
      return [event.actor];
   }
   return [];
}

/**
 * Applies WalletWhitelisted / WalletRemovedFromWhitelist events to the database so it
 * mirrors on-chain state, and invalidates the cache for the affected key/wallet pairs.
 */
export async function processWhitelistEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!ALL_WHITELIST_EVENT_TYPES.has(event.eventType)) {
         return;
      }

      const rawCreatorId =
         (event as any).creatorId ??
         (event as any).keyId ??
         (event as any).keyAddress;

      const wallets = extractWallets(event);

      if (!rawCreatorId || wallets.length === 0) {
         logger.warn(
            { eventId: `${event.txHash}:${event.eventIndex}` },
            'Skipping whitelist event with missing creatorId or wallets'
         );
         return;
      }

      const resolvedCreatorId =
         (await resolveCreatorId(rawCreatorId)) ?? rawCreatorId;

      const isAdd = WHITELIST_ADD_EVENT_TYPES.has(event.eventType);

      if (isAdd) {
         const creator = await prisma.creatorProfile.findFirst({
            where: {
               OR: [
                  { id: resolvedCreatorId },
                  { handle: resolvedCreatorId },
               ],
            },
            select: { id: true },
         });
         const targetId = creator?.id ?? resolvedCreatorId;

         await prisma.whitelist.createMany({
            data: wallets.map(address => ({ address, creatorId: targetId })),
            skipDuplicates: true,
         });

         for (const wallet of wallets) {
            await invalidateWhitelistCache(targetId, wallet);
         }
         await invalidateWhitelistCache(targetId);
      } else {
         await prisma.whitelist.deleteMany({
            where: { creatorId: resolvedCreatorId, address: { in: wallets } },
         });

         for (const wallet of wallets) {
            await invalidateWhitelistCache(resolvedCreatorId, wallet);
         }
         await invalidateWhitelistCache(resolvedCreatorId);
      }
   });
}
