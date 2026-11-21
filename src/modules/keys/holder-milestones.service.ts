import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';

export const HOLDER_MILESTONE_CACHE_TTL_SECONDS = 60;
export const HOLDER_MILESTONE_DAYS = [30, 90, 180, 365] as const;
export const holderMilestoneCacheKeys = {
   key: (keyId: string, wallet: string) => `keys:milestones:${keyId}:${wallet}`,
   wallet: (wallet: string) => `milestones:${wallet}`,
};

type Holding = { creatorId: string; createdAt: Date };
type Claim = {
   keyId: string;
   milestoneDays: number;
   claimedAt: Date;
   rewardAmount: unknown;
};

function buildStatus(holding: Holding, claims: Claim[], now: Date) {
   const firstPurchaseAt = new Date(holding.createdAt);
   const daysHeld = Math.max(
      0,
      Math.floor((now.getTime() - firstPurchaseAt.getTime()) / 86_400_000)
   );
   const byDay = new Map(claims.map(claim => [claim.milestoneDays, claim]));
   const milestones = HOLDER_MILESTONE_DAYS.map(days => {
      const claim = byDay.get(days);
      return {
         days,
         claimed: Boolean(claim),
         eligible: daysHeld >= days,
         days_remaining: Math.max(0, days - daysHeld),
         claimed_at: claim ? new Date(claim.claimedAt).toISOString() : null,
         reward_amount:
            claim?.rewardAmount == null ? null : String(claim.rewardAmount),
      };
   });
   return {
      key_id: holding.creatorId,
      first_purchase_at: firstPurchaseAt.toISOString(),
      days_held: daysHeld,
      milestones,
      next_eligible_milestone: milestones.find(item => !item.claimed) ?? null,
   };
}

async function loadWalletData(wallet: string, keyId?: string) {
   const holdings = (await prisma.keyOwnership.findMany({
      where: {
         ownerAddress: wallet,
         balance: { gt: 0 },
         ...(keyId ? { creatorId: keyId } : {}),
      },
      select: { creatorId: true, createdAt: true },
      orderBy: { creatorId: 'asc' },
   })) as Holding[];
   const claims = (await prisma.milestoneClaim.findMany({
      where: { wallet, ...(keyId ? { keyId } : {}) },
      select: {
         keyId: true,
         milestoneDays: true,
         claimedAt: true,
         rewardAmount: true,
      },
   })) as Claim[];
   return { holdings, claims };
}

export async function getKeyHolderMilestones(
   keyId: string,
   wallet: string,
   now = new Date()
) {
   const cacheKey = holderMilestoneCacheKeys.key(keyId, wallet);
   let data =
      await cacheGetJson<Awaited<ReturnType<typeof loadWalletData>>>(cacheKey);
   if (!data) {
      data = await loadWalletData(wallet, keyId);
      await cacheSetJson(cacheKey, data, HOLDER_MILESTONE_CACHE_TTL_SECONDS);
   }
   const holding = data.holdings[0];
   if (!holding)
      return {
         key_id: keyId,
         wallet,
         days_held: 0,
         milestones: [],
         next_eligible_milestone: null,
      };
   return { wallet, ...buildStatus(holding, data.claims, now) };
}

export async function getWalletMilestones(wallet: string, now = new Date()) {
   const cacheKey = holderMilestoneCacheKeys.wallet(wallet);
   let data =
      await cacheGetJson<Awaited<ReturnType<typeof loadWalletData>>>(cacheKey);
   if (!data) {
      data = await loadWalletData(wallet);
      await cacheSetJson(cacheKey, data, HOLDER_MILESTONE_CACHE_TTL_SECONDS);
   }
   return {
      wallet,
      keys: data.holdings.map(holding =>
         buildStatus(
            holding,
            data!.claims.filter(claim => claim.keyId === holding.creatorId),
            now
         )
      ),
   };
}
