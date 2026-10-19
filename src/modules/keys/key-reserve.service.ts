// src/modules/keys/key-reserve.service.ts
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';
import { Decimal } from '@prisma/client/runtime/library';

export class KeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'KeyNotFoundError';
   }
}

export interface KeyReserveResponse {
   key_id: string;
   reserve_balance: string;
   market_cap: string;
   reserve_ratio_bps: number;
   low_reserve: boolean;
}

export const RESERVE_CACHE_TTL_SECONDS = 60;
export const LOW_RESERVE_THRESHOLD_BPS = 1000; // 10%

export function getKeyReserveCacheKey(keyId: string): string {
   return `key:reserve:${keyId}`;
}

export async function invalidateKeyReserveCache(keyId: string): Promise<void> {
   try {
      await cacheInvalidate(getKeyReserveCacheKey(keyId));
   } catch (error) {
      logger.warn({ error, keyId }, 'Failed to invalidate key reserve cache');
   }
}

export async function getKeyReserve(keyId: string): Promise<KeyReserveResponse> {
   const cacheKey = getKeyReserveCacheKey(keyId);
   const cached = await cacheGetJson<KeyReserveResponse>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   const creator = await prisma.creatorProfile.findUnique({
      where: { id: keyId },
      select: { id: true, circulatingSupply: true },
   });

   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const [reserveRecord, priceSnapshot] = await Promise.all([
      prisma.keyReserve.findUnique({
         where: { keyId },
         select: { reserveBalance: true },
      }),
      prisma.creatorPriceSnapshot.findUnique({
         where: { creatorId: keyId },
         select: { currentPrice: true },
      }),
   ]);

   const reserveBalance = reserveRecord ? reserveRecord.reserveBalance : new Decimal(0);
   const supplyNum = Number(creator.circulatingSupply.toString());
   const currentPriceNum = priceSnapshot ? Number(priceSnapshot.currentPrice) : 0;

   // Calculate market cap: circulating supply * current price
   const marketCapNum = Math.max(0, supplyNum * currentPriceNum);
   const reserveNum = Number(reserveBalance.toString());

   let reserveRatioBps = 0;
   let lowReserve = false;

   if (marketCapNum > 0) {
      reserveRatioBps = Math.floor((reserveNum * 10000) / marketCapNum);
      lowReserve = reserveRatioBps < LOW_RESERVE_THRESHOLD_BPS;
   } else {
      reserveRatioBps = 0;
      lowReserve = false;
   }

   const result: KeyReserveResponse = {
      key_id: keyId,
      reserve_balance: reserveBalance.toString(),
      market_cap: marketCapNum.toString(),
      reserve_ratio_bps: reserveRatioBps,
      low_reserve: lowReserve,
   };

   try {
      await cacheSetJson(cacheKey, result, RESERVE_CACHE_TTL_SECONDS);
   } catch (error) {
      logger.warn({ error, keyId }, 'Failed to cache key reserve response');
   }

   return result;
}
