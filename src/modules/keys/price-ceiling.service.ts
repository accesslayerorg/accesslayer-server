// src/modules/keys/price-ceiling.service.ts
// Price ceiling and cool-off status read model (#1266).

import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
} from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';

export const PRICE_CEILING_CACHE_TTL_SECONDS = 30;

export const priceCeilingCacheKey = (keyId: string): string =>
   `keys:price-ceiling:${keyId.toLowerCase()}`;

export class KeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'KeyNotFoundError';
   }
}

export interface PriceCeilingStatus {
   keyId: string;
   ceiling: number | null;
   price: number | null;
   headroom: number | null;
   headroomPercentage: number | null;
   cooloffActive: boolean | null;
   cooloffEndsAt: number | null;
   cooloffLedgers: number | null;
}

/**
 * Invalidates Redis cache for a key's price ceiling status.
 */
export async function invalidatePriceCeilingCache(
   keyId: string
): Promise<void> {
   try {
      await cacheInvalidate(
         priceCeilingCacheKey(keyId),
         `creator:profile:${keyId}`
      );
   } catch (err) {
      logger.warn({ err, keyId }, 'Failed to invalidate price ceiling cache');
   }
}

/**
 * Checks whether buy cool-off is currently active for a ceiling record.
 */
export async function isCooloffActive(
   cooloffEndsAt: number | null | undefined,
   currentLedger?: number
): Promise<boolean> {
   if (cooloffEndsAt === null || cooloffEndsAt === undefined) {
      return false;
   }
   if (currentLedger !== undefined) {
      return currentLedger <= cooloffEndsAt;
   }
   try {
      const indexed = await prisma.indexedLedger.findFirst({
         orderBy: { ledger: 'desc' },
         select: { ledger: true },
      });
      if (!indexed) {
         return true;
      }
      return indexed.ledger <= cooloffEndsAt;
   } catch {
      return true;
   }
}

/**
 * Resolves the latest indexed price for a key.
 */
export async function getLatestIndexedPrice(
   keyId: string
): Promise<number | null> {
   try {
      const snapshot = await prisma.creatorPriceSnapshot.findUnique({
         where: { creatorId: keyId },
         select: { currentPrice: true },
      });
      if (snapshot && snapshot.currentPrice !== null) {
         return Number(snapshot.currentPrice);
      }

      const latestTrade = await prisma.trade.findFirst({
         where: { creatorId: keyId },
         orderBy: { timestamp: 'desc' },
         select: { price: true },
      });
      if (latestTrade && latestTrade.price) {
         const p = Number(latestTrade.price);
         return Number.isFinite(p) ? p : null;
      }
      return 0;
   } catch {
      return null;
   }
}

/**
 * Computes headroom given ceiling and price:
 * Headroom equals (ceiling - price) / ceiling.
 */
export function computeHeadroom(
   ceiling: number | null,
   price: number | null
): { headroom: number | null; headroomPercentage: number | null } {
   if (ceiling === null || ceiling <= 0) {
      return { headroom: null, headroomPercentage: null };
   }
   const p = price !== null ? price : 0;
   const headroom = (ceiling - p) / ceiling;
   return {
      headroom,
      headroomPercentage: headroom * 100,
   };
}

/**
 * Retrieves the current price ceiling and cool-off status for a key.
 * Returns null fields when key has no ceiling.
 *
 * @throws {KeyNotFoundError} when key does not exist in CreatorProfile.
 */
export async function getPriceCeilingStatus(
   keyIdOrHandle: string,
   currentLedger?: number
): Promise<PriceCeilingStatus> {
   const cacheKey = priceCeilingCacheKey(keyIdOrHandle);
   try {
      const cached = await cacheGetJson<PriceCeilingStatus>(cacheKey);
      if (cached) {
         return cached;
      }
   } catch {
      // cache miss
   }

   const profile = await prisma.creatorProfile.findFirst({
      where: {
         OR: [{ id: keyIdOrHandle }, { handle: keyIdOrHandle }],
      },
      select: { id: true },
   });

   if (!profile) {
      throw new KeyNotFoundError(keyIdOrHandle);
   }

   const keyId = profile.id;

   const priceCeiling = await prisma.priceCeiling.findUnique({
      where: { keyId },
   });

   if (!priceCeiling) {
      const nullStatus: PriceCeilingStatus = {
         keyId,
         ceiling: null,
         price: null,
         headroom: null,
         headroomPercentage: null,
         cooloffActive: null,
         cooloffEndsAt: null,
         cooloffLedgers: null,
      };
      try {
         await cacheSetJson(
            cacheKey,
            nullStatus,
            PRICE_CEILING_CACHE_TTL_SECONDS
         );
      } catch {
         // cache set non-blocking
      }
      return nullStatus;
   }

   const ceiling = Number(priceCeiling.ceiling);
   const latestPrice = await getLatestIndexedPrice(keyId);
   const { headroom, headroomPercentage } = computeHeadroom(
      ceiling,
      latestPrice
   );
   const cooloffActive = await isCooloffActive(
      priceCeiling.cooloffEndsAt,
      currentLedger
   );

   const status: PriceCeilingStatus = {
      keyId,
      ceiling,
      price: latestPrice,
      headroom,
      headroomPercentage,
      cooloffActive,
      cooloffEndsAt: priceCeiling.cooloffEndsAt,
      cooloffLedgers: priceCeiling.cooloffLedgers,
   };

   try {
      await cacheSetJson(cacheKey, status, PRICE_CEILING_CACHE_TTL_SECONDS);
   } catch {
      // cache set non-blocking
   }

   return status;
}
