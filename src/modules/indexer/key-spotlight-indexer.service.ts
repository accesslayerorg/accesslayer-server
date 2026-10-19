// src/modules/indexer/key-spotlight-indexer.service.ts
//
// Indexes key spotlight auction bids and awards from contract events (#1114).
//
// Events supported:
// - SpotlightBidPlaced (or SPOTLIGHT_BID_PLACED)
// - SpotlightAwarded (or SPOTLIGHT_AWARDED)

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { cacheInvalidate } from '../../utils/redis.utils';

export const SPOTLIGHT_EVENT_TYPES: ReadonlySet<string> = new Set([
   'SpotlightBidPlaced',
   'SPOTLIGHT_BID_PLACED',
   'SpotlightAwarded',
   'SPOTLIGHT_AWARDED',
]);

export function isSpotlightEvent(event: IndexerChainEvent): boolean {
   return SPOTLIGHT_EVENT_TYPES.has(event.eventType);
}

export interface SpotlightEventPayload extends IndexerChainEvent {
   slotId?: string | number;
   slot_id?: string | number;
   slot?: string | number;
   keyId?: string;
   creatorId?: string;
   key_id?: string;
   winningKeyId?: string;
   bidder?: string;
   winningBidder?: string;
   actor?: string;
   caller?: string;
   bidAmount?: string | number | bigint;
   bid_amount?: string | number | bigint;
   winningBid?: string | number | bigint;
   amount?: string | number | bigint;
   startsAt?: string | number | Date;
   starts_at?: string | number | Date;
   expiresAt?: string | number | Date;
   expires_at?: string | number | Date;
   endsAt?: string | number | Date;
   ends_at?: string | number | Date;
   durationSeconds?: number;
   duration?: number;
}

export function parseDate(value: unknown): Date | null {
   if (value === undefined || value === null || value === '') return null;
   if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
   }
   if (typeof value === 'number') {
      const ms = value < 1e12 ? value * 1000 : value;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d;
   }
   if (typeof value === 'string') {
      const trimmed = value.trim();
      if (/^\d+$/.test(trimmed)) {
         const n = Number(trimmed);
         const ms = n < 1e12 ? n * 1000 : n;
         const d = new Date(ms);
         return Number.isNaN(d.getTime()) ? null : d;
      }
      const d = new Date(trimmed);
      return Number.isNaN(d.getTime()) ? null : d;
   }
   return null;
}

/**
 * Processes on-chain SpotlightBidPlaced and SpotlightAwarded events.
 * Idempotently saves to spotlight_auctions table and invalidates cache.
 */
export async function processSpotlightEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async rawEvent => {
      if (!isSpotlightEvent(rawEvent)) {
         return;
      }

      const event = rawEvent as SpotlightEventPayload;
      const keyId =
         event.winningKeyId ||
         event.keyId ||
         event.creatorId ||
         event.key_id;
      if (!keyId || typeof keyId !== 'string') {
         logger.warn(
            { eventType: event.eventType, txHash: event.txHash },
            'Spotlight event skipped: missing keyId'
         );
         return;
      }

      const rawSlotId = event.slotId ?? event.slot_id ?? event.slot;
      const slotId = rawSlotId ? String(rawSlotId) : 'default-slot';

      const isAwarded = event.eventType.toUpperCase().includes('AWARDED');
      const isWinning = isAwarded;

      const rawBidAmount =
         event.winningBid ??
         event.bidAmount ??
         event.bid_amount ??
         event.amount;
      const bidAmount =
         rawBidAmount !== undefined && rawBidAmount !== null
            ? String(rawBidAmount)
            : null;

      const bidder =
         event.winningBidder ||
         event.bidder ||
         event.actor ||
         event.caller ||
         null;

      const startsAt =
         parseDate(event.startsAt ?? event.starts_at) ??
         (isAwarded ? new Date() : null);

      let expiresAt = parseDate(
         event.expiresAt ?? event.expires_at ?? event.endsAt ?? event.ends_at
      );
      if (!expiresAt && isAwarded) {
         const duration = event.durationSeconds ?? event.duration ?? 3600; // default 1h
         const baseMs = startsAt ? startsAt.getTime() : Date.now();
         expiresAt = new Date(baseMs + duration * 1000);
      }

      await prisma.spotlightAuction.upsert({
         where: {
            txHash_eventIndex: {
               txHash: event.txHash,
               eventIndex: event.eventIndex,
            },
         },
         create: {
            slotId,
            eventType: event.eventType,
            keyId,
            bidder,
            bidAmount,
            isWinning,
            startsAt,
            expiresAt,
            ledger: event.ledger ?? 0,
            txHash: event.txHash,
            eventIndex: event.eventIndex ?? 0,
         },
         update: {
            slotId,
            eventType: event.eventType,
            keyId,
            bidder,
            bidAmount,
            isWinning,
            startsAt,
            expiresAt,
         },
      });

      // Cache invalidation
      try {
         if (isAwarded) {
            await cacheInvalidate(
               'spotlight:active',
               `spotlight:bids:${slotId}`,
               `key:spotlight:history:${keyId}`
            );
         } else {
            await cacheInvalidate(`spotlight:bids:${slotId}`);
         }
      } catch {
         // Non-critical cache error
      }

      logger.info(
         {
            eventType: event.eventType,
            slotId,
            keyId,
            isWinning,
            txHash: event.txHash,
         },
         `Indexed ${event.eventType} for slot ${slotId} and key ${keyId}`
      );
   });
}
