// src/modules/staking/staking.service.ts
// Staking reward multiplier tiers and position effective weight calculations (#942).

import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
} from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';

export const STAKING_TIERS_CACHE_KEY = 'staking:multiplier-tiers';
export const STAKING_TIERS_CACHE_TTL_SECONDS = 300; // 5 minutes TTL

export class StakingPositionNotFoundError extends Error {
   constructor(positionId: string) {
      super(`Staking position not found: ${positionId}`);
      this.name = 'StakingPositionNotFoundError';
   }
}

export interface StakingMultiplierTierDto {
   tier: number;
   name: string;
   lockPeriod: number; // in seconds
   lockPeriodSeconds: number; // in seconds
   lockPeriodDays: number;
   multiplier: number;
   multiplierFormatted: string;
}

export interface StakingPositionResponse {
   id: string;
   wallet: string;
   keyId: string | null;
   amount: string;
   stakedAmount: string;
   balance?: string;
   lockPeriodSeconds: number;
   lockPeriod: number;
   lockedAt?: string;
   unlocksAt?: string | null;
   lockupExpiresAt?: string | null;
   tier: number;
   effectiveWeight: string;
   tierData: StakingMultiplierTierDto;
   is_frozen?: boolean;
   frozen_at?: string | null;
   createdAt: Date;
   updatedAt: Date;
}

export interface EffectiveWeightResult {
   positionId: string;
   wallet: string;
   stakedAmount: string;
   lockPeriodSeconds: number;
   lockPeriod: number;
   multiplier: number;
   multiplierFormatted: string;
   effectiveWeight: string;
   tier: StakingMultiplierTierDto;
}

/**
 * Standard contract configuration default multiplier tiers.
 * Used as fallback before the indexer captures a live contract event
 * or if the database is initially unpopulated.
 */
export const DEFAULT_CONTRACT_MULTIPLIER_TIERS: StakingMultiplierTierDto[] = [
   {
      tier: 0,
      name: 'Tier 0 (Flexible)',
      lockPeriod: 0,
      lockPeriodSeconds: 0,
      lockPeriodDays: 0,
      multiplier: 1.0,
      multiplierFormatted: '1x',
   },
   {
      tier: 1,
      name: 'Tier 1 (30 Days)',
      lockPeriod: 30 * 24 * 60 * 60, // 2,592,000s
      lockPeriodSeconds: 30 * 24 * 60 * 60,
      lockPeriodDays: 30,
      multiplier: 1.25,
      multiplierFormatted: '1.25x',
   },
   {
      tier: 2,
      name: 'Tier 2 (90 Days)',
      lockPeriod: 90 * 24 * 60 * 60, // 7,776,000s
      lockPeriodSeconds: 90 * 24 * 60 * 60,
      lockPeriodDays: 90,
      multiplier: 1.5,
      multiplierFormatted: '1.5x',
   },
   {
      tier: 3,
      name: 'Tier 3 (180 Days)',
      lockPeriod: 180 * 24 * 60 * 60, // 15,552,000s
      lockPeriodSeconds: 180 * 24 * 60 * 60,
      lockPeriodDays: 180,
      multiplier: 2.0,
      multiplierFormatted: '2x',
   },
   {
      tier: 4,
      name: 'Tier 4 (365 Days)',
      lockPeriod: 365 * 24 * 60 * 60, // 31,536,000s
      lockPeriodSeconds: 365 * 24 * 60 * 60,
      lockPeriodDays: 365,
      multiplier: 2.5,
      multiplierFormatted: '2.5x',
   },
];

/**
 * Invalidate the cached staking multiplier tiers in Redis.
 * Must be called whenever a contract configuration update event is processed.
 */
export async function invalidateStakingTiersCache(): Promise<void> {
   await cacheInvalidate(STAKING_TIERS_CACHE_KEY);
   logger.info(
      { cacheKey: STAKING_TIERS_CACHE_KEY },
      'Staking multiplier tiers cache invalidated'
   );
}

/**
 * Returns all staking multiplier tiers with lock periods and multipliers.
 * Caches in Redis with 5 minute TTL (300 seconds).
 */
export async function getMultiplierTiers(): Promise<
   StakingMultiplierTierDto[]
> {
   // 1. Check Redis cache first
   const cached = await cacheGetJson<StakingMultiplierTierDto[]>(
      STAKING_TIERS_CACHE_KEY
   );
   if (cached && Array.isArray(cached) && cached.length > 0) {
      return cached;
   }

   // 2. Fetch from DB
   let dbTiers: any[] = [];
   try {
      if (prisma.stakingMultiplierTier) {
         dbTiers = await prisma.stakingMultiplierTier.findMany({
            orderBy: { tier: 'asc' },
         });
      }
   } catch (error) {
      logger.warn(
         { error: error instanceof Error ? error.message : String(error) },
         'Could not fetch staking multiplier tiers from DB, using contract defaults'
      );
   }

   let result: StakingMultiplierTierDto[];

   if (dbTiers && dbTiers.length > 0) {
      result = dbTiers.map(t => {
         const mult = Number(t.multiplier);
         return {
            tier: t.tier,
            name: t.name ?? `Tier ${t.tier}`,
            lockPeriod: t.lockPeriodSeconds,
            lockPeriodSeconds: t.lockPeriodSeconds,
            lockPeriodDays: Math.round(t.lockPeriodSeconds / 86400),
            multiplier: mult,
            multiplierFormatted: `${mult}x`,
         };
      });
   } else {
      // Fallback to default contract tiers
      result = DEFAULT_CONTRACT_MULTIPLIER_TIERS;

      // Seed defaults into database in the background if empty
      try {
         if (prisma.stakingMultiplierTier) {
            for (const tier of DEFAULT_CONTRACT_MULTIPLIER_TIERS) {
               await prisma.stakingMultiplierTier.upsert({
                  where: { tier: tier.tier },
                  create: {
                     tier: tier.tier,
                     name: tier.name,
                     lockPeriodSeconds: tier.lockPeriodSeconds,
                     multiplier: tier.multiplier,
                  },
                  update: {},
               });
            }
         }
      } catch {
         // Seeding failure is non-fatal
      }
   }

   // 3. Cache for 5 minutes (300s)
   await cacheSetJson(
      STAKING_TIERS_CACHE_KEY,
      result,
      STAKING_TIERS_CACHE_TTL_SECONDS
   );

   return result;
}

/**
 * Match the highest tier corresponding to a lock period duration in seconds.
 */
export function matchTierForLockPeriod(
   lockPeriodSeconds: number,
   tiers: StakingMultiplierTierDto[]
): StakingMultiplierTierDto {
   const sorted = [...tiers].sort(
      (a, b) => b.lockPeriodSeconds - a.lockPeriodSeconds
   );
   for (const tier of sorted) {
      if (lockPeriodSeconds >= tier.lockPeriodSeconds) {
         return tier;
      }
   }
   return sorted[sorted.length - 1] ?? DEFAULT_CONTRACT_MULTIPLIER_TIERS[0];
}

/**
 * Calculate effective weight for a stake amount given a multiplier.
 * Effective Weight = Stake Amount * Multiplier
 */
export function calculateEffectiveWeight(
   stakeAmount: number | string,
   multiplier: number | string
): string {
   const amount = Number(stakeAmount);
   const mult = Number(multiplier);
   if (isNaN(amount) || isNaN(mult) || amount < 0 || mult < 0) {
      return '0';
   }
   const weight = amount * mult;
   // Format cleanly: keep up to 7 decimal places matching stroop / XLM precision
   if (Number.isInteger(weight)) {
      return weight.toString();
   }
   const formatted = weight.toFixed(7);
   // Trim trailing zeroes for cleaner display
   return parseFloat(formatted).toString();
}

/**
 * Retrieve a staking position by ID and embed current tier data and effective weight.
 * Searches `StakingPosition` first, then falls back to `KeyOwnership` positions.
 */
export async function getStakingPositionById(
   id: string
): Promise<StakingPositionResponse> {
   const tiers = await getMultiplierTiers();

   // 1. Try finding in StakingPosition
   let stakingPos: any = null;
   try {
      if (prisma.stakingPosition) {
         stakingPos = await prisma.stakingPosition.findUnique({
            where: { id },
         });
      }
   } catch {
      // Ignored, fallback
   }

   if (stakingPos) {
      let matchedTier: StakingMultiplierTierDto | undefined;
      if (stakingPos.tier !== undefined && stakingPos.tier !== null) {
         matchedTier = tiers.find(t => t.tier === stakingPos.tier);
      }
      if (!matchedTier) {
         matchedTier = matchTierForLockPeriod(
            stakingPos.lockPeriodSeconds,
            tiers
         );
      }

      const effectiveWeight = calculateEffectiveWeight(
         stakingPos.amount.toString(),
         matchedTier.multiplier
      );

      return {
         id: stakingPos.id,
         wallet: stakingPos.wallet,
         keyId: stakingPos.keyId,
         amount: stakingPos.amount.toString(),
         stakedAmount: stakingPos.amount.toString(),
         lockPeriodSeconds: stakingPos.lockPeriodSeconds,
         lockPeriod: stakingPos.lockPeriodSeconds,
         lockedAt: stakingPos.lockedAt.toISOString(),
         unlocksAt: stakingPos.unlocksAt
            ? stakingPos.unlocksAt.toISOString()
            : null,
         tier: matchedTier.tier,
         effectiveWeight,
         tierData: matchedTier,
         createdAt: stakingPos.createdAt,
         updatedAt: stakingPos.updatedAt,
      };
   }

   // 2. Fallback: try finding in KeyOwnership
   let ownership: any = null;
   try {
      if (prisma.keyOwnership) {
         ownership = await prisma.keyOwnership.findUnique({
            where: { id },
         });
      }
   } catch {
      // Ignored
   }

   if (ownership) {
      let lockPeriodSeconds = 0;
      if (ownership.lockupExpiresAt) {
         const startTime = ownership.lastBuyAt ?? ownership.createdAt;
         const diffMs =
            ownership.lockupExpiresAt.getTime() - startTime.getTime();
         lockPeriodSeconds = Math.max(0, Math.round(diffMs / 1000));
      }

      const matchedTier = matchTierForLockPeriod(lockPeriodSeconds, tiers);
      const effectiveWeight = calculateEffectiveWeight(
         ownership.balance.toString(),
         matchedTier.multiplier
      );

      return {
         id: ownership.id,
         wallet: ownership.ownerAddress,
         keyId: ownership.creatorId,
         amount: ownership.balance.toString(),
         stakedAmount: ownership.balance.toString(),
         balance: ownership.balance.toString(),
         lockPeriodSeconds,
         lockPeriod: lockPeriodSeconds,
         lockupExpiresAt: ownership.lockupExpiresAt
            ? ownership.lockupExpiresAt.toISOString()
            : null,
         tier: matchedTier.tier,
         effectiveWeight,
         tierData: matchedTier,
         is_frozen: ownership.frozen,
         frozen_at: ownership.frozenAt
            ? ownership.frozenAt.toISOString()
            : null,
         createdAt: ownership.createdAt,
         updatedAt: ownership.updatedAt,
      };
   }

   throw new StakingPositionNotFoundError(id);
}

/**
 * List staking positions with embedded tier data.
 */
export async function getStakingPositions(filter?: {
   wallet?: string;
}): Promise<StakingPositionResponse[]> {
   const tiers = await getMultiplierTiers();
   const results: StakingPositionResponse[] = [];

   // Search StakingPosition records
   try {
      if (prisma.stakingPosition) {
         const positions = await prisma.stakingPosition.findMany({
            where: filter?.wallet ? { wallet: filter.wallet } : {},
            orderBy: { createdAt: 'desc' },
         });

         for (const pos of positions) {
            let matchedTier = tiers.find(t => t.tier === pos.tier);
            if (!matchedTier) {
               matchedTier = matchTierForLockPeriod(
                  pos.lockPeriodSeconds,
                  tiers
               );
            }
            results.push({
               id: pos.id,
               wallet: pos.wallet,
               keyId: pos.keyId,
               amount: pos.amount.toString(),
               stakedAmount: pos.amount.toString(),
               lockPeriodSeconds: pos.lockPeriodSeconds,
               lockPeriod: pos.lockPeriodSeconds,
               lockedAt: pos.lockedAt.toISOString(),
               unlocksAt: pos.unlocksAt ? pos.unlocksAt.toISOString() : null,
               tier: matchedTier.tier,
               effectiveWeight: calculateEffectiveWeight(
                  pos.amount.toString(),
                  matchedTier.multiplier
               ),
               tierData: matchedTier,
               createdAt: pos.createdAt,
               updatedAt: pos.updatedAt,
            });
         }
      }
   } catch {
      // Ignored
   }

   // If looking up by wallet and no direct StakingPosition rows, check KeyOwnership positions
   if (filter?.wallet && results.length === 0) {
      try {
         if (prisma.keyOwnership) {
            const ownerships = await prisma.keyOwnership.findMany({
               where: { ownerAddress: filter.wallet, balance: { gt: 0 } },
               orderBy: { updatedAt: 'desc' },
            });

            for (const row of ownerships) {
               let lockPeriodSeconds = 0;
               if (row.lockupExpiresAt) {
                  const startTime = row.lastBuyAt ?? row.createdAt;
                  const diffMs =
                     row.lockupExpiresAt.getTime() - startTime.getTime();
                  lockPeriodSeconds = Math.max(0, Math.round(diffMs / 1000));
               }
               const matchedTier = matchTierForLockPeriod(
                  lockPeriodSeconds,
                  tiers
               );
               results.push({
                  id: row.id,
                  wallet: row.ownerAddress,
                  keyId: row.creatorId,
                  amount: row.balance.toString(),
                  stakedAmount: row.balance.toString(),
                  balance: row.balance.toString(),
                  lockPeriodSeconds,
                  lockPeriod: lockPeriodSeconds,
                  lockupExpiresAt: row.lockupExpiresAt
                     ? row.lockupExpiresAt.toISOString()
                     : null,
                  tier: matchedTier.tier,
                  effectiveWeight: calculateEffectiveWeight(
                     row.balance.toString(),
                     matchedTier.multiplier
                  ),
                  tierData: matchedTier,
                  is_frozen: row.frozen,
                  frozen_at: row.frozenAt ? row.frozenAt.toISOString() : null,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
               });
            }
         }
      } catch {
         // Ignored
      }
   }

   return results;
}

/**
 * Returns the effective weight calculation for a given position ID.
 */
export async function getPositionEffectiveWeight(
   id: string
): Promise<EffectiveWeightResult> {
   const position = await getStakingPositionById(id);
   return {
      positionId: position.id,
      wallet: position.wallet,
      stakedAmount: position.stakedAmount,
      lockPeriodSeconds: position.lockPeriodSeconds,
      lockPeriod: position.lockPeriod,
      multiplier: position.tierData.multiplier,
      multiplierFormatted: position.tierData.multiplierFormatted,
      effectiveWeight: position.effectiveWeight,
      tier: position.tierData,
   };
}
