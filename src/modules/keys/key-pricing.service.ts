// src/modules/keys/key-pricing.service.ts
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import { computeBuyCost, computeSellPayout } from '../../utils/pricing.utils';

export class KeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'KeyNotFoundError';
   }
}

export interface PriceResult {
   keyId: string;
   currentSupply: number;
   buyPrice: string;
   sellPrice: string;
   buyPriceForQuantity?: string;
   sellPriceForQuantity?: string;
   priceImpactPercentage?: number;
}

export async function getKeyPrice(
   keyId: string,
   quantity: number = 1
): Promise<PriceResult> {
   const cacheKey = `key:price:${keyId}:${quantity}`;
   const cached = await cacheGetJson<PriceResult>(cacheKey);
   if (cached) {
      return cached;
   }

   const creator = await prisma.creatorProfile.findUnique({
      where: { id: keyId },
      select: {
         id: true,
         circulatingSupply: true,
         feeBps: true,
      },
   });

   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const currentSupply = Number(creator.circulatingSupply.toString());
   const feeBps = creator.feeBps || 500; // Default 5% fee

   const buyPrice = computeBuyCost(currentSupply, 1, feeBps);
   const sellPrice = computeSellPayout(currentSupply, 1, feeBps);

   let buyPriceForQuantity: bigint | undefined;
   let sellPriceForQuantity: bigint | undefined;
   let priceImpactPercentage: number | undefined;

   if (quantity > 1) {
      buyPriceForQuantity = computeBuyCost(currentSupply, quantity, feeBps);
      sellPriceForQuantity = computeSellPayout(currentSupply, quantity, feeBps);

      // Calculate price impact for buy
      const unitBuyPrice = Number(buyPrice);
      const avgBuyPrice = Number(buyPriceForQuantity) / quantity;
      priceImpactPercentage = ((avgBuyPrice - unitBuyPrice) / unitBuyPrice) * 100;
   }

   const result: PriceResult = {
      keyId,
      currentSupply,
      buyPrice: buyPrice.toString(),
      sellPrice: sellPrice.toString(),
      ...(buyPriceForQuantity && { buyPriceForQuantity: buyPriceForQuantity.toString() }),
      ...(sellPriceForQuantity && { sellPriceForQuantity: sellPriceForQuantity.toString() }),
      ...(priceImpactPercentage !== undefined && { priceImpactPercentage }),
   };

   await cacheSetJson(cacheKey, result, 10); // 10 second TTL

   return result;
}
