// src/modules/indexer/staking-tier-indexer.service.ts
// Handles contract configuration update events for staking multiplier tiers (#942).

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { invalidateStakingTiersCache } from '../staking/staking.service';

export interface MultiplierTierConfigItem {
   tier: number;
   name?: string;
   lockPeriodSeconds: number;
   multiplier: number | string;
}

/**
 * Chain event emitted when staking reward multiplier tiers are configured or updated.
 */
export interface StakingTierConfigUpdateEvent extends IndexerChainEvent {
   eventType: 'TIER_CONFIG_UPDATED' | 'STAKING_TIER_CONFIG_UPDATED';
   tiers: MultiplierTierConfigItem[];
   contractAddress?: string;
   updatedAt?: string;
}

/**
 * Processes on-chain tier configuration update events.
 *
 * - Validates incoming tier data.
 * - Upserts tiers into the StakingMultiplierTier read model.
 * - Removes obsolete tiers if any are removed.
 * - Invalidates the Redis cache so subsequent reads reflect new config immediately.
 */
export async function processStakingTierEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (
         event.eventType !== 'TIER_CONFIG_UPDATED' &&
         event.eventType !== 'STAKING_TIER_CONFIG_UPDATED'
      ) {
         return;
      }

      const typedEvent = event as StakingTierConfigUpdateEvent;
      if (!Array.isArray(typedEvent.tiers) || typedEvent.tiers.length === 0) {
         logger.warn(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
               eventType: event.eventType,
            },
            'Skipping staking tier config update event: missing or empty tiers array'
         );
         return;
      }

      // Validate each tier item
      for (const item of typedEvent.tiers) {
         if (
            typeof item.tier !== 'number' ||
            typeof item.lockPeriodSeconds !== 'number' ||
            item.multiplier === undefined ||
            item.multiplier === null
         ) {
            logger.warn(
               {
                  eventId: `${event.txHash}:${event.eventIndex}`,
                  invalidTier: item,
               },
               'Skipping staking tier event: malformed tier item'
            );
            return;
         }
      }

      // Upsert tiers in database
      if (prisma.stakingMultiplierTier) {
         for (const tierItem of typedEvent.tiers) {
            await prisma.stakingMultiplierTier.upsert({
               where: { tier: tierItem.tier },
               create: {
                  tier: tierItem.tier,
                  name: tierItem.name ?? `Tier ${tierItem.tier}`,
                  lockPeriodSeconds: tierItem.lockPeriodSeconds,
                  multiplier: tierItem.multiplier,
               },
               update: {
                  name: tierItem.name ?? `Tier ${tierItem.tier}`,
                  lockPeriodSeconds: tierItem.lockPeriodSeconds,
                  multiplier: tierItem.multiplier,
               },
            });
         }
      }

      // Invalidate the 5-minute Redis cache on update event
      await invalidateStakingTiersCache();

      logger.info(
         {
            eventType: event.eventType,
            tierCount: typedEvent.tiers.length,
            txHash: event.txHash,
            ledger: event.ledger,
         },
         'Staking multiplier tiers updated from contract event'
      );
   });
}
