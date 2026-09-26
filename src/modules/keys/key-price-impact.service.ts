import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import { getBuyUnitPrice, getSellUnitPrice } from '../../utils/pricing.utils';
import { logger } from '../../utils/logger.utils';

export class KeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'KeyNotFoundError';
   }
}

export interface PriceImpactResponse {
   impactPercentage: number;
   preTradePrice: string;
   postTradePrice: string;
}

/**
 * Calculate price impact for a given trade quantity and direction.
 * Uses current on-chain supply for accurate calculation.
 * Response cached with 10s TTL per key.
 *
 * @param keyId - The creator key ID
 * @param quantity - Number of keys to trade
 * @param direction - 'buy' or 'sell'
 * @param feeBps - Protocol fee in basis points (default 500 = 5%)
 * @returns Price impact data including pre/post-trade prices and impact percentage
 */
export async function getPriceImpact(
   keyId: string,
   quantity: number,
   direction: 'buy' | 'sell',
   feeBps: number = 500
): Promise<PriceImpactResponse> {
   // Validate inputs
   if (quantity <= 0) {
      throw new Error('Quantity must be greater than 0');
   }

   if (direction !== 'buy' && direction !== 'sell') {
      throw new Error('Direction must be "buy" or "sell"');
   }

   // Try cache first
   const cacheKey = `price-impact:${keyId}:${direction}:${quantity}`;
   const cached = await cacheGetJson<PriceImpactResponse>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   // Get current supply from database (on-chain state)
   const creator = await prisma.creatorProfile.findUnique({
      where: { id: keyId },
      select: { circulatingSupply: true },
   });

   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const currentSupply = Number(creator.circulatingSupply);

   // Calculate pre-trade and post-trade prices
   let preTradePrice: bigint;
   let postTradePrice: bigint;
   let postSupply: number;

   if (direction === 'buy') {
      // Pre-trade: current unit buy price
      preTradePrice = getBuyUnitPrice(currentSupply, feeBps);
      // Post-trade: unit buy price after this trade
      postSupply = currentSupply + quantity;
      postTradePrice = getBuyUnitPrice(postSupply, feeBps);
   } else {
      // Pre-trade: current unit sell price
      preTradePrice = getSellUnitPrice(currentSupply, feeBps);
      // Post-trade: unit sell price after this trade
      postSupply = currentSupply - quantity;
      if (postSupply < 0) {
         throw new Error('Cannot sell more keys than current supply');
      }
      postTradePrice = getSellUnitPrice(postSupply, feeBps);
   }

   // Calculate impact percentage
   // For buys: impact = (postTradePrice - preTradePrice) / preTradePrice * 100
   // For sells: impact = (preTradePrice - postTradePrice) / preTradePrice * 100
   // Expressed as decimal percentage (e.g., 2.5 = 2.5%)
   let impactPercentage: number;

   if (direction === 'buy') {
      if (preTradePrice === 0n) {
         impactPercentage = 0;
      } else {
         const priceDiff = Number(postTradePrice - preTradePrice);
         const preTradePriceNum = Number(preTradePrice);
         impactPercentage = (priceDiff / preTradePriceNum) * 100;
      }
   } else {
      if (preTradePrice === 0n) {
         impactPercentage = 0;
      } else {
         const priceDiff = Number(preTradePrice - postTradePrice);
         const preTradePriceNum = Number(preTradePrice);
         impactPercentage = (priceDiff / preTradePriceNum) * 100;
      }
   }

   const result: PriceImpactResponse = {
      impactPercentage,
      preTradePrice: preTradePrice.toString(),
      postTradePrice: postTradePrice.toString(),
   };

   // Cache with 10s TTL
   try {
      await cacheSetJson(cacheKey, result, 10);
   } catch (error) {
      logger.warn(
         { error, keyId, quantity, direction },
         'Failed to cache price impact'
      );
      // Continue without cache - caching is optional
   }

   return result;
}
