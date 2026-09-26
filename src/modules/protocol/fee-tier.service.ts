import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import { createAuditEntry } from '../admin/audit-log.service';
import { emitAuditEvent } from '../../utils/audit.utils';
import { logger } from '../../utils/logger.utils';

export interface FeeTier {
   volumeThreshold: number; // In stroops (XLM * 10^7)
   feeBps: number;
   label: string;
}

export interface CurrentFeeResponse {
   currentFeeBps: number;
   tierLabel: string;
   volume24hStroops: string;
   volumeUntilNextTier: string | null;
}

const CACHE_TTL_SECONDS = 60;
const CACHE_KEY = 'protocol:current-fee-tier';

/**
 * Default fee tier configuration.
 * Tiers are evaluated in ascending order; the highest tier with volume >= threshold is selected.
 */
const DEFAULT_TIERS: Array<{
   volumeThreshold: number;
   feeBps: number;
   label: string;
}> = [
   { volumeThreshold: 0, feeBps: 500, label: 'TIER_1' },
   { volumeThreshold: 1_000_000_000_000, feeBps: 400, label: 'TIER_2' }, // 100,000 XLM
   { volumeThreshold: 5_000_000_000_000, feeBps: 300, label: 'TIER_3' }, // 500,000 XLM
];

/**
 * Load fee tier configuration from ProtocolConfig.
 * Returns default tiers if not configured.
 */
export async function loadFeeTierConfig(): Promise<FeeTier[]> {
   try {
      const config = await prisma.protocolConfig.findUnique({
         where: { id: 'default' },
         select: { feeTiers: true },
      });

      if (!config || !config.feeTiers) {
         return DEFAULT_TIERS;
      }

      const tiers = config.feeTiers as Array<{
         volumeThreshold: number;
         feeBps: number;
         label?: string;
      }>;

      // Validate and add labels if missing
      return tiers.map((tier, index) => ({
         volumeThreshold: tier.volumeThreshold,
         feeBps: tier.feeBps,
         label: tier.label || `TIER_${index + 1}`,
      }));
   } catch (error) {
      logger.warn({ error }, 'Failed to load fee tier config; using defaults');
      return DEFAULT_TIERS;
   }
}

/**
 * Calculate rolling 24h trading volume (sum of all trade prices in stroops).
 */
async function calculate24hVolume(): Promise<bigint> {
   const now = new Date();
   const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

   const trades = await prisma.activity.findMany({
      where: {
         type: { in: ['KEY_BOUGHT', 'KEY_SOLD'] },
         createdAt: {
            gte: twentyFourHoursAgo,
            lte: now,
         },
      },
      select: { payload: true },
   });

   let totalVolume = 0n;
   for (const trade of trades) {
      const payload = trade.payload as Record<string, any>;
      if (payload && typeof payload.price !== 'undefined') {
         totalVolume += BigInt(payload.price);
      }
   }

   return totalVolume;
}

/**
 * Get current fee tier based on rolling 24h volume.
 * Cached with 60s TTL.
 * Returns active fee percentage and tier label.
 */
export async function getCurrentFeeTier(): Promise<CurrentFeeResponse> {
   // Try cache first
   const cached = await cacheGetJson<CurrentFeeResponse>(CACHE_KEY);
   if (cached !== null) {
      return cached;
   }

   // Calculate 24h volume
   const volume24h = await calculate24hVolume();

   // Load tier configuration
   const tiers = await loadFeeTierConfig();

   // Sort by volume threshold descending to find the highest applicable tier
   const sortedTiers = [...tiers].sort(
      (a, b) => b.volumeThreshold - a.volumeThreshold
   );

   let activeTier = tiers[0]; // Default to first tier
   let nextTierIndex = -1;

   // Find the highest tier where volume >= threshold
   for (let i = 0; i < sortedTiers.length; i++) {
      if (volume24h >= BigInt(sortedTiers[i].volumeThreshold)) {
         activeTier = sortedTiers[i];
         // Find next tier (lower threshold than current)
         nextTierIndex = tiers.findIndex(
            t => t.volumeThreshold > activeTier.volumeThreshold
         );
         break;
      }
   }

   // Calculate volume until next tier
   let volumeUntilNextTier: string | null = null;
   if (nextTierIndex !== -1) {
      const nextThreshold = BigInt(tiers[nextTierIndex].volumeThreshold);
      const diff = nextThreshold - volume24h;
      if (diff > 0n) {
         volumeUntilNextTier = diff.toString();
      }
   }

   const result: CurrentFeeResponse = {
      currentFeeBps: activeTier.feeBps,
      tierLabel: activeTier.label,
      volume24hStroops: volume24h.toString(),
      volumeUntilNextTier,
   };

   // Cache with 60s TTL
   try {
      await cacheSetJson(CACHE_KEY, result, CACHE_TTL_SECONDS);
   } catch (error) {
      logger.warn({ error }, 'Failed to cache fee tier result');
   }

   return result;
}

/**
 * Invalidate fee tier cache (called on new trade events).
 */
export async function invalidateFeeTierCache(): Promise<void> {
   try {
      const { cacheInvalidate } = await import('../../utils/redis.utils');
      await cacheInvalidate(CACHE_KEY);
   } catch (error) {
      logger.warn({ error }, 'Failed to invalidate fee tier cache');
   }
}

/**
 * Update fee tier configuration.
 * Admin only.
 */
export async function updateFeeTierConfig(
   newTiers: Array<{ volumeThreshold: number; feeBps: number; label?: string }>,
   adminWallet: string
): Promise<FeeTier[]> {
   // Validate tiers
   if (!Array.isArray(newTiers) || newTiers.length === 0) {
      throw new Error('At least one tier must be provided');
   }

   // Ensure first tier has threshold of 0
   if (newTiers[0].volumeThreshold !== 0) {
      throw new Error('First tier must have volumeThreshold of 0');
   }

   // Ensure thresholds are in ascending order
   for (let i = 1; i < newTiers.length; i++) {
      if (newTiers[i].volumeThreshold <= newTiers[i - 1].volumeThreshold) {
         throw new Error('Fee tier thresholds must be in ascending order');
      }
   }

   // Update configuration
   const updatedTiers = newTiers.map((tier, index) => ({
      volumeThreshold: tier.volumeThreshold,
      feeBps: tier.feeBps,
      label: tier.label || `TIER_${index + 1}`,
   }));

   await prisma.protocolConfig.upsert({
      where: { id: 'default' },
      create: {
         id: 'default',
         feeTiers: updatedTiers as any,
      },
      update: {
         feeTiers: updatedTiers as any,
      },
      select: { feeTiers: true },
   });

   // Invalidate cache
   await invalidateFeeTierCache();

   // Audit log
   await createAuditEntry({
      actorWallet: adminWallet,
      actionType: 'FEE_TIER_UPDATED',
      targetId: 'protocol',
      payload: {
         tiers: updatedTiers,
      },
   });

   // Audit event
   await emitAuditEvent({
      actor: adminWallet,
      action: 'fee_tier_updated',
      target: 'ProtocolConfig',
      targetId: 'default',
      metadata: { tiers: updatedTiers },
   });

   logger.info(
      { adminWallet, tiers: updatedTiers },
      'Fee tier configuration updated'
   );

   return updatedTiers;
}

/**
 * Record tier transition in audit log (called when tier changes).
 */
export async function recordTierTransition(
   previousTier: string,
   newTier: string,
   volume24hStroops: string
): Promise<void> {
   try {
      await emitAuditEvent({
         actor: 'system',
         action: 'fee_tier_transitioned',
         target: 'Protocol',
         targetId: 'default',
         metadata: {
            previousTier,
            newTier,
            volume24hStroops,
         },
      });

      logger.info(
         { previousTier, newTier, volume24hStroops },
         'Fee tier transition recorded'
      );
   } catch (error) {
      logger.warn({ error }, 'Failed to record tier transition');
   }
}
