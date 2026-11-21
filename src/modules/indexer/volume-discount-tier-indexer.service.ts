// src/modules/indexer/volume-discount-tier-indexer.service.ts
// Handles on-chain contract events for volume discount tiers (#1030).

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { invalidateVolumeDiscountTiersCache } from '../traders/trader-discount.service';

export interface VolumeDiscountTierItem {
   tier: number;
   name?: string;
   volumeThreshold: string | number | bigint;
   discountBps?: number;
   feeBps?: number;
}

export interface VolumeDiscountTierChangedEvent extends IndexerChainEvent {
   eventType:
      | 'VolumeDiscountTierChanged'
      | 'VOLUME_DISCOUNT_TIER_CHANGED'
      | 'VolumeDiscountTierConfigUpdated'
      | 'VOLUME_TIER_CONFIG_UPDATED';
   tier?: number;
   name?: string;
   volumeThreshold?: string | number | bigint;
   discountBps?: number;
   feeBps?: number;
   tiers?: VolumeDiscountTierItem[];
}

export const VOLUME_DISCOUNT_EVENT_TYPES = new Set([
   'VolumeDiscountTierChanged',
   'VOLUME_DISCOUNT_TIER_CHANGED',
   'VolumeDiscountTierConfigUpdated',
   'VOLUME_TIER_CONFIG_UPDATED',
]);

/**
 * Validates a single tier item.
 */
function isValidTierItem(item: any): item is VolumeDiscountTierItem {
   if (typeof item !== 'object' || item === null) return false;
   if (typeof item.tier !== 'number' || !Number.isInteger(item.tier) || item.tier < 0) {
      return false;
   }
   if (item.volumeThreshold === undefined || item.volumeThreshold === null) {
      return false;
   }
   try {
      const v = BigInt(item.volumeThreshold);
      if (v < 0n) return false;
   } catch {
      return false;
   }

   const discountBps = item.discountBps ?? (item.feeBps !== undefined ? Math.max(0, 500 - item.feeBps) : undefined);
   if (
      typeof discountBps !== 'number' ||
      !Number.isInteger(discountBps) ||
      discountBps < 0 ||
      discountBps > 10000
   ) {
      return false;
   }

   return true;
}

/**
 * Processes on-chain VolumeDiscountTierChanged events.
 *
 * - Deduplicates events based on txHash and eventIndex.
 * - Validates incoming tier data.
 * - Upserts tiers into VolumeDiscountTier read model.
 * - Invalidates the Redis cache so lookups reflect updated tiers immediately.
 */
export async function processVolumeDiscountTierEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!VOLUME_DISCOUNT_EVENT_TYPES.has(event.eventType)) {
         return;
      }

      const typedEvent = event as VolumeDiscountTierChangedEvent;
      const tierItems: VolumeDiscountTierItem[] = [];

      if (Array.isArray(typedEvent.tiers) && typedEvent.tiers.length > 0) {
         for (const item of typedEvent.tiers) {
            if (isValidTierItem(item)) {
               tierItems.push({
                  tier: item.tier,
                  name: item.name,
                  volumeThreshold: item.volumeThreshold,
                  discountBps:
                     item.discountBps ??
                     (item.feeBps !== undefined ? Math.max(0, 500 - item.feeBps) : 0),
               });
            } else {
               logger.warn(
                  {
                     eventId: `${event.txHash}:${event.eventIndex}`,
                     invalidTier: item,
                  },
                  'Skipping invalid volume discount tier item'
               );
               return;
            }
         }
      } else if (isValidTierItem(typedEvent)) {
         tierItems.push({
            tier: typedEvent.tier!,
            name: typedEvent.name,
            volumeThreshold: typedEvent.volumeThreshold!,
            discountBps:
               typedEvent.discountBps ??
               (typedEvent.feeBps !== undefined ? Math.max(0, 500 - typedEvent.feeBps) : 0),
         });
      } else {
         logger.warn(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
               eventType: event.eventType,
            },
            'Skipping volume discount tier event: missing or malformed tier data'
         );
         return;
      }

      // Upsert tiers in database
      if (prisma.volumeDiscountTier) {
         for (const item of tierItems) {
            await prisma.volumeDiscountTier.upsert({
               where: { tier: item.tier },
               create: {
                  tier: item.tier,
                  name: item.name ?? `TIER_${item.tier}`,
                  volumeThreshold: BigInt(item.volumeThreshold).toString(),
                  discountBps: item.discountBps ?? 0,
               },
               update: {
                  name: item.name ?? `TIER_${item.tier}`,
                  volumeThreshold: BigInt(item.volumeThreshold).toString(),
                  discountBps: item.discountBps ?? 0,
               },
            });
         }
      }

      // Invalidate Redis caches so subsequent reads reflect new config
      await invalidateVolumeDiscountTiersCache();

      logger.info(
         {
            eventType: event.eventType,
            tierCount: tierItems.length,
            txHash: event.txHash,
            ledger: event.ledger,
         },
         'Volume discount tiers updated from contract event'
      );
   });
}
