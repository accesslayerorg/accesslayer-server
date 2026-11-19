// src/modules/keys/key-fees.service.ts
import { prisma } from '../../utils/prisma.utils';
import { getRedis } from '../../utils/redis.utils';
import {
   KEY_FEES_CACHE_TTL_SECONDS,
   REDIS_KEYS,
} from '../../constants/notifications.constants';

import { getTraderDiscount } from '../traders/trader-discount.service';

export type KeyFees = {
   protocolFeeBps: number;
   creatorRoyaltyBuyBps: number;
   creatorRoyaltySellBps: number;
   discountTier?: number;
   tier?: number;
   discountBps?: number;
   volumeTierDiscountBps?: number;
};

export class KeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'KeyNotFoundError';
   }
}

async function loadProtocolFeeBps(): Promise<number> {
   const config = await prisma.protocolConfig.upsert({
      where: { id: 'default' },
      create: { id: 'default', protocolFeeBps: 500 },
      update: {},
      select: { protocolFeeBps: true },
   });
   return config.protocolFeeBps;
}

export async function getKeyFees(keyId: string, wallet?: string): Promise<KeyFees> {
   if (!wallet) {
      const redis = getRedis();
      const cacheKey = REDIS_KEYS.keyFees(keyId);
      if (redis) {
         const cached = await redis.get(cacheKey);
         if (cached) {
            return JSON.parse(cached) as KeyFees;
         }
      }
   }

   const creator = await prisma.creatorProfile.findUnique({
      where: { id: keyId },
      select: {
         creatorRoyaltyBuyBps: true,
         creatorRoyaltySellBps: true,
      },
   });

   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   let protocolFeeBps = await loadProtocolFeeBps();
   let discountTier: number | undefined;
   let discountBps: number | undefined;

   if (wallet) {
      const traderDiscount = await getTraderDiscount(wallet);
      discountTier = traderDiscount.tier;
      discountBps = traderDiscount.discountBps;
      protocolFeeBps = Math.max(0, protocolFeeBps - discountBps);
   }

   const fees: KeyFees = {
      protocolFeeBps,
      creatorRoyaltyBuyBps: creator.creatorRoyaltyBuyBps,
      creatorRoyaltySellBps: creator.creatorRoyaltySellBps,
      ...(discountTier !== undefined ? { discountTier, tier: discountTier } : {}),
      ...(discountBps !== undefined ? { discountBps, volumeTierDiscountBps: discountBps } : {}),
   };

   if (!wallet) {
      const redis = getRedis();
      const cacheKey = REDIS_KEYS.keyFees(keyId);
      if (redis) {
         await redis.set(
            cacheKey,
            JSON.stringify(fees),
            'EX',
            KEY_FEES_CACHE_TTL_SECONDS
         );
      }
   }

   return fees;
}

export async function invalidateKeyFeesCache(keyId: string): Promise<void> {
   const redis = getRedis();
   if (redis) {
      await redis.del(REDIS_KEYS.keyFees(keyId));
   }
}

/**
 * Invalidate fee caches for every known key. Used when the protocol fee changes.
 */
export async function invalidateAllKeyFeesCaches(): Promise<void> {
   const redis = getRedis();
   if (!redis) return;
   const creators = await prisma.creatorProfile.findMany({
      select: { id: true },
   });
   if (creators.length === 0) {
      return;
   }
   const pipeline = redis.pipeline();
   for (const creator of creators) {
      pipeline.del(REDIS_KEYS.keyFees(creator.id));
   }
   await pipeline.exec();
}

export async function updateProtocolFeeBps(
   protocolFeeBps: number
): Promise<{ protocolFeeBps: number }> {
   const updated = await prisma.protocolConfig.upsert({
      where: { id: 'default' },
      create: { id: 'default', protocolFeeBps },
      update: { protocolFeeBps },
      select: { protocolFeeBps: true },
   });
   await invalidateAllKeyFeesCaches();
   return updated;
}

export async function updateCreatorRoyalties(
   keyId: string,
   royalties: {
      creatorRoyaltyBuyBps?: number;
      creatorRoyaltySellBps?: number;
   }
): Promise<KeyFees> {
   const creator = await prisma.creatorProfile.findUnique({
      where: { id: keyId },
      select: { id: true },
   });
   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   await prisma.creatorProfile.update({
      where: { id: keyId },
      data: {
         ...(royalties.creatorRoyaltyBuyBps !== undefined
            ? { creatorRoyaltyBuyBps: royalties.creatorRoyaltyBuyBps }
            : {}),
         ...(royalties.creatorRoyaltySellBps !== undefined
            ? { creatorRoyaltySellBps: royalties.creatorRoyaltySellBps }
            : {}),
      },
   });

   await invalidateKeyFeesCache(keyId);
   return getKeyFees(keyId);
}
