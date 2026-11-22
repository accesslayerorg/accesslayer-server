// src/modules/indexer/price-ceiling-indexer.service.ts
// Indexes ceiling_set, ceiling_hit and ceiling_raised contract events (#1266).

import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { invalidatePriceCeilingCache } from '../keys/price-ceiling.service';

export const PRICE_CEILING_SET_EVENTS = new Set([
   'ceiling_set',
   'CEILING_SET',
   'CeilingSet',
]);

export const PRICE_CEILING_HIT_EVENTS = new Set([
   'ceiling_hit',
   'CEILING_HIT',
   'CeilingHit',
]);

export const PRICE_CEILING_RAISED_EVENTS = new Set([
   'ceiling_raised',
   'CEILING_RAISED',
   'CeilingRaised',
]);

export const PRICE_CEILING_EVENT_TYPES = new Set([
   ...PRICE_CEILING_SET_EVENTS,
   ...PRICE_CEILING_HIT_EVENTS,
   ...PRICE_CEILING_RAISED_EVENTS,
]);

export interface PriceCeilingChainEvent extends IndexerChainEvent {
   keyId?: string | null;
   creatorId?: string | null;
   ceiling?: number | string | Decimal | null;
   newCeiling?: number | string | Decimal | null;
   new_ceiling?: number | string | Decimal | null;
   amount?: number | string | Decimal | null;
   cooloffLedgers?: number | string | null;
   cooloff_ledgers?: number | string | null;
   cooloffEndsAt?: number | string | null;
   cooloff_ends_at?: number | string | null;
   endLedger?: number | string | null;
   ledger: number;
   txHash: string;
   eventIndex: number;
}

/**
 * Processes a batch of price ceiling events (ceiling_set, ceiling_hit, ceiling_raised).
 */
export async function processPriceCeilingEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!PRICE_CEILING_EVENT_TYPES.has(event.eventType)) {
         return;
      }

      const typed = event as PriceCeilingChainEvent;
      const keyId = (typed.keyId ?? typed.creatorId ?? '').trim();

      if (!keyId) {
         logger.warn(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
               eventType: event.eventType,
            },
            'Skipping price ceiling event with missing key identifier'
         );
         return;
      }

      // ── Handle ceiling_set ──────────────────────────────────
      if (PRICE_CEILING_SET_EVENTS.has(event.eventType)) {
         const rawCeiling = typed.ceiling ?? typed.amount;
         if (
            rawCeiling === undefined ||
            rawCeiling === null ||
            rawCeiling === ''
         ) {
            logger.warn(
               { eventId: `${event.txHash}:${event.eventIndex}` },
               'Skipping ceiling_set event with missing ceiling value'
            );
            return;
         }

         const cooloffLedgers = Number(
            typed.cooloffLedgers ?? typed.cooloff_ledgers ?? 0
         );
         const ceilingDecimal = new Decimal(rawCeiling.toString());

         await prisma.priceCeiling.upsert({
            where: { keyId },
            create: {
               keyId,
               ceiling: ceilingDecimal,
               cooloffLedgers: Number.isFinite(cooloffLedgers)
                  ? cooloffLedgers
                  : 0,
               cooloffEndsAt: null,
            },
            update: {
               ceiling: ceilingDecimal,
               cooloffLedgers: Number.isFinite(cooloffLedgers)
                  ? cooloffLedgers
                  : 0,
               cooloffEndsAt: null,
            },
         });

         await invalidatePriceCeilingCache(keyId);
         logger.info(
            { keyId, ceiling: ceilingDecimal.toString() },
            'Price ceiling set indexed'
         );
         return;
      }

      // ── Handle ceiling_hit ──────────────────────────────────
      if (PRICE_CEILING_HIT_EVENTS.has(event.eventType)) {
         const existing = await prisma.priceCeiling.findUnique({
            where: { keyId },
         });

         const rawCooloffLedgers =
            typed.cooloffLedgers ?? typed.cooloff_ledgers;
         const cooloffLedgers =
            rawCooloffLedgers !== undefined && rawCooloffLedgers !== null
               ? Number(rawCooloffLedgers)
               : (existing?.cooloffLedgers ?? 0);

         const rawEndsAt =
            typed.cooloffEndsAt ?? typed.cooloff_ends_at ?? typed.endLedger;
         const endLedger =
            rawEndsAt !== undefined && rawEndsAt !== null
               ? Number(rawEndsAt)
               : Number(typed.ledger ?? 0) + cooloffLedgers;

         if (existing) {
            await prisma.priceCeiling.update({
               where: { keyId },
               data: {
                  cooloffEndsAt: endLedger,
                  ...(rawCooloffLedgers !== undefined &&
                  rawCooloffLedgers !== null
                     ? { cooloffLedgers }
                     : {}),
               },
            });
         } else if (typed.ceiling !== undefined && typed.ceiling !== null) {
            await prisma.priceCeiling.create({
               data: {
                  keyId,
                  ceiling: new Decimal(typed.ceiling.toString()),
                  cooloffLedgers,
                  cooloffEndsAt: endLedger,
               },
            });
         } else {
            logger.warn(
               { eventId: `${event.txHash}:${event.eventIndex}`, keyId },
               'Received ceiling_hit for unknown key with no ceiling specified'
            );
            return;
         }

         await invalidatePriceCeilingCache(keyId);
         logger.info(
            { keyId, endLedger },
            'Price ceiling hit indexed; cool-off started'
         );
         return;
      }

      // ── Handle ceiling_raised ────────────────────────────────
      if (PRICE_CEILING_RAISED_EVENTS.has(event.eventType)) {
         const rawCeiling =
            typed.ceiling ??
            typed.newCeiling ??
            typed.new_ceiling ??
            typed.amount;
         if (
            rawCeiling === undefined ||
            rawCeiling === null ||
            rawCeiling === ''
         ) {
            logger.warn(
               { eventId: `${event.txHash}:${event.eventIndex}` },
               'Skipping ceiling_raised event with missing ceiling value'
            );
            return;
         }

         const ceilingDecimal = new Decimal(rawCeiling.toString());
         const rawCooloffLedgers =
            typed.cooloffLedgers ?? typed.cooloff_ledgers;
         const rawEndsAt =
            typed.cooloffEndsAt ?? typed.cooloff_ends_at ?? typed.endLedger;

         await prisma.priceCeiling.upsert({
            where: { keyId },
            create: {
               keyId,
               ceiling: ceilingDecimal,
               cooloffLedgers:
                  rawCooloffLedgers !== undefined && rawCooloffLedgers !== null
                     ? Number(rawCooloffLedgers)
                     : 0,
               cooloffEndsAt:
                  rawEndsAt !== undefined && rawEndsAt !== null
                     ? Number(rawEndsAt)
                     : null,
            },
            update: {
               ceiling: ceilingDecimal,
               ...(rawCooloffLedgers !== undefined && rawCooloffLedgers !== null
                  ? { cooloffLedgers: Number(rawCooloffLedgers) }
                  : {}),
               ...(rawEndsAt !== undefined && rawEndsAt !== null
                  ? { cooloffEndsAt: Number(rawEndsAt) }
                  : {}),
            },
         });

         await invalidatePriceCeilingCache(keyId);
         logger.info(
            { keyId, newCeiling: ceilingDecimal.toString() },
            'Price ceiling raised indexed'
         );
      }
   });
}
