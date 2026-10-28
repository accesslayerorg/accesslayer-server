import { z } from 'zod';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   IndexerChainEvent,
   processIndexerChainEvents,
} from '../../utils/indexer-event-processor.utils';
import {
   chainPositionSchema,
   eventIdentifierSchema,
   eventOccurredAt,
} from '../../utils/indexer-event-fields.utils';
import { isBadgeType } from '../badges/badge.types';
import { invalidateWalletBadgeCache } from '../badges/badge-read.service';
import { StellarAddressSchema } from '../wallet/wallet.schemas';

export const BADGE_MINTED_EVENT_TYPES = new Set([
   'BadgeMinted',
   'BADGE_MINTED',
]);

const badgeMintedPayloadSchema = z.object({
   wallet: eventIdentifierSchema,
   badgeType: eventIdentifierSchema,
});

export async function processBadgeMintedEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!BADGE_MINTED_EVENT_TYPES.has(event.eventType)) return;

      const position = chainPositionSchema.safeParse(event);
      const payload = badgeMintedPayloadSchema.safeParse({
         wallet:
            event.wallet ??
            event.recipient ??
            event.to ??
            event.owner ??
            event.actor,
         badgeType: event.badgeType ?? event.badge_type ?? event.type,
      });
      const wallet = payload.success
         ? StellarAddressSchema.safeParse(payload.data.wallet)
         : null;
      const badgeType =
         payload.success && isBadgeType(payload.data.badgeType)
            ? payload.data.badgeType
            : null;
      const rawTimestamp =
         event.mintedAt ?? event.timestamp ?? event.ledgerClosedAt;

      if (
         !position.success ||
         !payload.success ||
         !wallet?.success ||
         !badgeType ||
         rawTimestamp === undefined ||
         rawTimestamp === null
      ) {
         logger.error(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
               eventType: event.eventType,
            },
            'BadgeMinted event is missing valid chain position, wallet, type, or timestamp'
         );
         throw new Error('Invalid BadgeMinted event payload');
      }

      let mintedAt: Date;
      try {
         mintedAt = eventOccurredAt({ ...event, timestamp: rawTimestamp });
      } catch (error) {
         logger.error(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
               error: error instanceof Error ? error.message : String(error),
            },
            'BadgeMinted event has an invalid timestamp'
         );
         throw error;
      }

      await prisma.walletBadge.createMany({
         data: [
            {
               wallet: wallet.data,
               badgeType,
               mintedAt,
               ...position.data,
            },
         ],
         skipDuplicates: true,
      });

      await invalidateWalletBadgeCache(wallet.data);
   });
}
