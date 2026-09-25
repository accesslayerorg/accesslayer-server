// src/modules/keys/key-twap.service.ts
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';

export class KeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'KeyNotFoundError';
   }
}

export interface TWAPResult {
   keyId: string;
   window: string;
   twapPrice: string;
   dataPoints: number;
   startTime: Date;
   endTime: Date;
}

const WINDOW_MS: Record<string, number> = {
   '1h': 60 * 60 * 1000,
   '24h': 24 * 60 * 60 * 1000,
   '7d': 7 * 24 * 60 * 60 * 1000,
};

export async function getKeyTWAP(
   keyId: string,
   window: string = '24h'
): Promise<TWAPResult> {
   const windowMs = WINDOW_MS[window];
   if (!windowMs) {
      throw new Error(`Invalid window: ${window}. Valid options: ${Object.keys(WINDOW_MS).join(', ')}`);
   }

   const cacheKey = `key:twap:${keyId}:${window}`;
   const cached = await cacheGetJson<TWAPResult>(cacheKey);
   if (cached) {
      return cached;
   }

   const creator = await prisma.creatorProfile.findUnique({
      where: { id: keyId },
      select: { id: true },
   });

   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const endTime = new Date();
   const startTime = new Date(endTime.getTime() - windowMs);

   const priceHistory = await prisma.creatorPriceHistory.findMany({
      where: {
         creatorId: keyId,
         recordedAt: { gte: startTime, lte: endTime },
      },
      orderBy: { recordedAt: 'asc' },
   });

   if (priceHistory.length === 0) {
      // Fallback: return current price snapshot
      const snapshot = await prisma.creatorPriceSnapshot.findUnique({
         where: { creatorId: keyId },
      });

      const result: TWAPResult = {
         keyId,
         window,
         twapPrice: snapshot?.currentPrice.toString() || '0',
         dataPoints: 0,
         startTime,
         endTime,
      };

      await cacheSetJson(cacheKey, result, Math.floor(windowMs / 1000)); // TTL matches window

      return result;
   }

   // Calculate time-weighted average price
   let weightedSum = 0n;
   let totalWeight = 0n;

   for (let i = 0; i < priceHistory.length; i++) {
      const current = priceHistory[i];
      const price = BigInt(current.price.toString());

      let timeWeight: bigint;
      if (i === priceHistory.length - 1) {
         // Last point: weight from its timestamp to endTime
         timeWeight = BigInt(endTime.getTime() - current.recordedAt.getTime());
      } else {
         // Weight from this point to the next point
         const nextPoint = priceHistory[i + 1];
         timeWeight = BigInt(nextPoint.recordedAt.getTime() - current.recordedAt.getTime());
      }

      weightedSum += price * timeWeight;
      totalWeight += timeWeight;
   }

   const twapPrice = totalWeight > 0n ? weightedSum / totalWeight : 0n;

   const result: TWAPResult = {
      keyId,
      window,
      twapPrice: twapPrice.toString(),
      dataPoints: priceHistory.length,
      startTime,
      endTime,
   };

   await cacheSetJson(cacheKey, result, Math.floor(windowMs / 1000)); // TTL matches window

   return result;
}
