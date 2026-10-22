import { BADGE_TYPES, type BadgeType } from './badge.types';
import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheInvalidate,
   cacheSetJson,
} from '../../utils/redis.utils';

export const WALLET_BADGES_CACHE_TTL_SECONDS = 5 * 60;

const BADGE_NAMES: Record<BadgeType, string> = {
   FIRST_BUYER: 'First Buyer',
   WHALE_HOLDER: 'Whale Holder',
   GOVERNANCE_VOTER: 'Governance Voter',
   DIAMOND_HANDS: 'Diamond Hands',
   TOP_TRADER: 'Top Trader',
};

export interface WalletBadgeItem {
   type: BadgeType;
   name: string;
   mintedAt: string | null;
}

export interface WalletBadgeCollection {
   earned: WalletBadgeItem[];
   locked: WalletBadgeItem[];
   totalEarned: number;
}

export interface WalletBadgeSummary {
   totalEarned: number;
   byType: Array<{ type: BadgeType; name: string; count: number }>;
}

const collectionCacheKey = (wallet: string): string =>
   `wallet-badges:v1:${wallet}:collection`;
const summaryCacheKey = (wallet: string): string =>
   `wallet-badges:v1:${wallet}:summary`;

export async function getWalletBadgeCollection(
   wallet: string
): Promise<WalletBadgeCollection> {
   const key = collectionCacheKey(wallet);
   const cached = await cacheGetJson<WalletBadgeCollection>(key);
   if (cached) return cached;

   const rows = await prisma.walletBadge.findMany({
      where: { wallet },
      select: { badgeType: true, mintedAt: true },
      orderBy: { mintedAt: 'desc' },
   });
   const earnedTypes = new Set(rows.map(row => row.badgeType));
   const mintedAtByType = new Map(
      rows.map(row => [row.badgeType, row.mintedAt.toISOString()])
   );

   const earned: WalletBadgeItem[] = [];
   const locked: WalletBadgeItem[] = [];
   for (const type of BADGE_TYPES) {
      const item = {
         type,
         name: BADGE_NAMES[type],
         mintedAt: mintedAtByType.get(type) ?? null,
      };
      if (earnedTypes.has(type)) earned.push(item);
      else locked.push(item);
   }

   const result = { earned, locked, totalEarned: earned.length };
   await cacheSetJson(key, result, WALLET_BADGES_CACHE_TTL_SECONDS);
   return result;
}

export async function getWalletBadgeSummary(
   wallet: string
): Promise<WalletBadgeSummary> {
   const key = summaryCacheKey(wallet);
   const cached = await cacheGetJson<WalletBadgeSummary>(key);
   if (cached) return cached;

   const rows = await prisma.walletBadge.groupBy({
      by: ['badgeType'],
      where: { wallet },
      _count: { _all: true },
   });
   const counts = new Map(rows.map(row => [row.badgeType, row._count._all]));
   const byType = BADGE_TYPES.map(type => ({
      type,
      name: BADGE_NAMES[type],
      count: counts.get(type) ?? 0,
   }));
   const result = {
      totalEarned: byType.reduce((total, badge) => total + badge.count, 0),
      byType,
   };

   await cacheSetJson(key, result, WALLET_BADGES_CACHE_TTL_SECONDS);
   return result;
}

export async function invalidateWalletBadgeCache(
   wallet: string
): Promise<void> {
   await cacheInvalidate(collectionCacheKey(wallet), summaryCacheKey(wallet));
}
