// src/modules/indexer/issuer-verification-indexer.service.ts
// Indexes VerificationGranted and VerificationRevoked contract events (#1179).
//
// Each event is appended to issuer_verification_events once per chain
// position. Only a newly inserted event updates the issuer_verification state
// row, so replays cannot flip a status. Events are applied in chain order,
// which the indexer pipeline guarantees.

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
import { invalidateIssuerVerificationCache } from '../issuers/issuer-verification.service';
import { chainTimestamp } from './invoice-protocol.events';

export const VERIFICATION_GRANTED_EVENT_TYPES = new Set([
   'VerificationGranted',
   'VERIFICATION_GRANTED',
]);
export const VERIFICATION_REVOKED_EVENT_TYPES = new Set([
   'VerificationRevoked',
   'VERIFICATION_REVOKED',
]);
export const ISSUER_VERIFICATION_EVENT_TYPES = new Set([
   ...VERIFICATION_GRANTED_EVENT_TYPES,
   ...VERIFICATION_REVOKED_EVENT_TYPES,
]);

const verificationPayload = z.object({
   wallet: eventIdentifierSchema,
   /** Only meaningful on a grant; a revoke clears the tier. */
   tier: eventIdentifierSchema.nullable().optional(),
});

export async function processIssuerVerificationEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      const isGrant = VERIFICATION_GRANTED_EVENT_TYPES.has(event.eventType);
      const isRevoke = VERIFICATION_REVOKED_EVENT_TYPES.has(event.eventType);
      if (!isGrant && !isRevoke) {
         return;
      }

      const position = chainPositionSchema.safeParse(event);
      const payload = verificationPayload.safeParse({
         wallet: event.wallet ?? event.issuer,
         tier: event.tier,
      });
      if (!position.success || !payload.success) {
         logger.warn(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
               eventType: event.eventType,
            },
            'Skipping verification event with missing or invalid fields'
         );
         return;
      }

      const wallet = payload.data.wallet;
      const tier = isGrant ? (payload.data.tier ?? null) : null;
      const expiresAt = isGrant
         ? parseExpiry(event.expiry_timestamp ?? event.expiresAt)
         : null;

      await prisma.$transaction(async tx => {
         const { count } = await tx.issuerVerificationEvent.createMany({
            data: [
               {
                  wallet,
                  eventType: event.eventType,
                  tier,
                  expiresAt,
                  occurredAt: eventOccurredAt(event),
                  ...position.data,
               },
            ],
            skipDuplicates: true,
         });
         if (count === 0) {
            return;
         }
         await tx.issuerVerification.upsert({
            where: { wallet },
            create: {
               wallet,
               isVerified: isGrant,
               tier,
               expiresAt,
               lastLedger: position.data.ledger,
            },
            update: {
               isVerified: isGrant,
               tier,
               expiresAt,
               lastLedger: position.data.ledger,
            },
         });
      });

      await invalidateIssuerVerificationCache(wallet);
   });
}

/** Expiry may arrive as unix seconds or ISO-8601; absent means no expiry. */
function parseExpiry(value: unknown): Date | null {
   if (value === undefined || value === null || value === '') {
      return null;
   }
   return chainTimestamp(value);
}
