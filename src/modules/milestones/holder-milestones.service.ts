import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';
import {
   REDIS_KEYS,
   HOLDER_MILESTONES_CACHE_TTL_SECONDS,
} from '../../constants/notifications.constants';

export class KeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'KeyNotFoundError';
   }
}

export interface HoldingMilestoneTier {
   tier: number;
   milestoneId: string;
   requiredDays: number;
   label: string;
}

export const HOLDER_MILESTONE_TIERS: HoldingMilestoneTier[] = [
   { tier: 1, milestoneId: 'holding_7d', requiredDays: 7, label: '7 Days Holding' },
   { tier: 2, milestoneId: 'holding_30d', requiredDays: 30, label: '30 Days Holding' },
   { tier: 3, milestoneId: 'holding_90d', requiredDays: 90, label: '90 Days Holding' },
   { tier: 4, milestoneId: 'holding_180d', requiredDays: 180, label: '180 Days Holding' },
   { tier: 5, milestoneId: 'holding_365d', requiredDays: 365, label: '365 Days Holding' },
];

export interface MilestoneStatusItem {
   tier: number;
   milestone_id: string;
   required_days: number;
   days_remaining: number;
   claimed: boolean;
   claimed_at: string | null;
}

export interface NextEligibleMilestone {
   tier: number;
   milestone_id: string;
   required_days: number;
   days_remaining: number;
   eligible_now: boolean;
}

export interface KeyHolderMilestonesResponse {
   key_id: string;
   wallet: string;
   days_held: number;
   first_purchase_at: string | null;
   milestones: MilestoneStatusItem[];
   next_eligible_milestone: NextEligibleMilestone | null;
}

export interface WalletHoldingMilestoneStatus {
   key_id: string;
   creator_handle: string | null;
   balance: string;
   days_held: number;
   first_purchase_at: string | null;
   claimed_milestones: string[];
   next_eligible_milestone: NextEligibleMilestone | null;
}

export interface WalletAllMilestonesResponse {
   wallet: string;
   holdings: WalletHoldingMilestoneStatus[];
}

/**
 * Computes first purchase timestamp for a wallet and key pair (#1115).
 */
export async function getFirstPurchaseTimestamp(
   keyId: string,
   wallet: string
): Promise<Date | null> {
   // Check earliest Activity purchase
   const activity = await prisma.activity.findFirst({
      where: {
         actor: wallet,
         creatorId: keyId,
         type: 'KEY_BOUGHT',
      },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
   });

   if (activity) {
      return activity.createdAt;
   }

   // Check earliest ActivityLog purchase
   const activityLog = await prisma.activityLog.findFirst({
      where: {
         actor: wallet,
         keyId,
         type: 'buy',
      },
      orderBy: { timestamp: 'asc' },
      select: { timestamp: true },
   });

   if (activityLog) {
      return activityLog.timestamp;
   }

   // Fallback to KeyOwnership creation timestamp
   const ownership = await prisma.keyOwnership.findUnique({
      where: {
         ownerAddress_creatorId: {
            ownerAddress: wallet,
            creatorId: keyId,
         },
      },
      select: { createdAt: true },
   });

   return ownership?.createdAt ?? null;
}

/**
 * Returns milestone status, claimed milestones, and days held for a specific key/wallet pair (#1115).
 */
export async function getKeyHolderMilestones(
   keyId: string,
   wallet: string
): Promise<KeyHolderMilestonesResponse> {
   const cacheKey = REDIS_KEYS.holderMilestonesKey(keyId, wallet);
   const cached = await cacheGetJson<KeyHolderMilestonesResponse>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: { id: true },
   });

   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const targetKeyId = creator.id;
   const firstPurchaseDate = await getFirstPurchaseTimestamp(targetKeyId, wallet);
   const now = Date.now();
   const daysHeld = firstPurchaseDate
      ? Math.max(0, Math.floor((now - new Date(firstPurchaseDate).getTime()) / (1000 * 60 * 60 * 24)))
      : 0;

   const claims = await (prisma as any).milestoneClaim.findMany({
      where: {
         keyId: targetKeyId,
         wallet,
      },
   });

   const claimsMap = new Map<string, any>();
   for (const c of claims) {
      claimsMap.set(c.milestoneId, c);
      if (c.tier !== null && c.tier !== undefined) {
         claimsMap.set(String(c.tier), c);
      }
   }

   let nextEligible: NextEligibleMilestone | null = null;

   const milestones: MilestoneStatusItem[] = HOLDER_MILESTONE_TIERS.map(tier => {
      const claim = claimsMap.get(tier.milestoneId) || claimsMap.get(String(tier.tier));
      const claimed = !!claim;
      const daysRemaining = Math.max(0, tier.requiredDays - daysHeld);

      if (!claimed && !nextEligible) {
         nextEligible = {
            tier: tier.tier,
            milestone_id: tier.milestoneId,
            required_days: tier.requiredDays,
            days_remaining: daysRemaining,
            eligible_now: daysHeld >= tier.requiredDays,
         };
      }

      return {
         tier: tier.tier,
         milestone_id: tier.milestoneId,
         required_days: tier.requiredDays,
         days_remaining: daysRemaining,
         claimed,
         claimed_at: claim?.claimedAt ? new Date(claim.claimedAt).toISOString() : null,
      };
   });

   const response: KeyHolderMilestonesResponse = {
      key_id: targetKeyId,
      wallet,
      days_held: daysHeld,
      first_purchase_at: firstPurchaseDate ? firstPurchaseDate.toISOString() : null,
      milestones,
      next_eligible_milestone: nextEligible,
   };

   await cacheSetJson(cacheKey, response, HOLDER_MILESTONES_CACHE_TTL_SECONDS);
   return response;
}

/**
 * Returns milestone status across all held keys for a wallet (#1115).
 */
export async function getWalletAllMilestones(
   wallet: string
): Promise<WalletAllMilestonesResponse> {
   const cacheKey = REDIS_KEYS.holderMilestonesWallet(wallet);
   const cached = await cacheGetJson<WalletAllMilestonesResponse>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   const holdings = await prisma.keyOwnership.findMany({
      where: {
         ownerAddress: wallet,
         balance: { gt: 0 },
      },
      orderBy: { createdAt: 'desc' },
   });

   if (holdings.length === 0) {
      const empty: WalletAllMilestonesResponse = {
         wallet,
         holdings: [],
      };
      await cacheSetJson(cacheKey, empty, HOLDER_MILESTONES_CACHE_TTL_SECONDS);
      return empty;
   }

   const creatorIds = holdings.map(h => h.creatorId);
   const [creators, allClaims] = await Promise.all([
      prisma.creatorProfile.findMany({
         where: { id: { in: creatorIds } },
         select: { id: true, handle: true },
      }),
      (prisma as any).milestoneClaim.findMany({
         where: {
            wallet,
            keyId: { in: creatorIds },
         },
      }),
   ]);

   const handleMap = new Map(creators.map(c => [c.id, c.handle]));
   const claimsByKey = new Map<string, any[]>();
   for (const c of allClaims) {
      const list = claimsByKey.get(c.keyId) || [];
      list.push(c);
      claimsByKey.set(c.keyId, list);
   }

   const now = Date.now();
   const holdingStatuses: WalletHoldingMilestoneStatus[] = [];

   for (const h of holdings) {
      const firstPurchaseDate = (await getFirstPurchaseTimestamp(h.creatorId, wallet)) ?? h.createdAt;
      const daysHeld = firstPurchaseDate
         ? Math.max(0, Math.floor((now - new Date(firstPurchaseDate).getTime()) / (1000 * 60 * 60 * 24)))
         : 0;

      const keyClaims = claimsByKey.get(h.creatorId) || [];
      const claimedSet = new Set<string>();
      for (const c of keyClaims) {
         claimedSet.add(c.milestoneId);
         if (c.tier !== null && c.tier !== undefined) {
            claimedSet.add(String(c.tier));
         }
      }

      let nextEligible: NextEligibleMilestone | null = null;
      for (const tier of HOLDER_MILESTONE_TIERS) {
         const claimed = claimedSet.has(tier.milestoneId) || claimedSet.has(String(tier.tier));
         if (!claimed) {
            const daysRemaining = Math.max(0, tier.requiredDays - daysHeld);
            nextEligible = {
               tier: tier.tier,
               milestone_id: tier.milestoneId,
               required_days: tier.requiredDays,
               days_remaining: daysRemaining,
               eligible_now: daysHeld >= tier.requiredDays,
            };
            break;
         }
      }

      holdingStatuses.push({
         key_id: h.creatorId,
         creator_handle: handleMap.get(h.creatorId) ?? null,
         balance: h.balance.toString(),
         days_held: daysHeld,
         first_purchase_at: firstPurchaseDate ? new Date(firstPurchaseDate).toISOString() : null,
         claimed_milestones: keyClaims.map(c => c.milestoneId),
         next_eligible_milestone: nextEligible,
      });
   }

   const response: WalletAllMilestonesResponse = {
      wallet,
      holdings: holdingStatuses,
   };

   await cacheSetJson(cacheKey, response, HOLDER_MILESTONES_CACHE_TTL_SECONDS);
   return response;
}

/**
 * Invalidates cached milestone responses for a wallet and key pair (#1115).
 */
export async function invalidateHolderMilestonesCache(
   keyId: string,
   wallet: string
): Promise<void> {
   try {
      await Promise.all([
         cacheInvalidate(REDIS_KEYS.holderMilestonesKey(keyId, wallet)),
         cacheInvalidate(REDIS_KEYS.holderMilestonesWallet(wallet)),
      ]);
   } catch (error) {
      logger.warn({ error, keyId, wallet }, 'Failed to invalidate holder milestones cache');
   }
}
