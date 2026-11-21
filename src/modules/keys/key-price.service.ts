// src/modules/keys/key-price.service.ts
//
// Computes the current buy / sell price for a quantity of keys on the
// bonding curve and returns a structured response.  Results are cached in
// Redis for 10 seconds; cache failures are swallowed so they never break
// a request.

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import {
   buyCost,
   sellProceeds,
   spotPrice,
   validateMilestones,
   Milestone,
} from '../../utils/bonding-curve.utils';

import { KeyNotFoundError } from './key-fees.service';

export { KeyNotFoundError };

const PRICE_CACHE_TTL_SECONDS = 10;

export interface KeyPriceBuySide {
   /** Average cost per key (stroops, as string). */
   unitPrice: string;
   /** Total cost to buy (stroops, as string). */
   totalCost: string;
}

export interface KeyPriceSellSide {
   /** Average proceeds per key (stroops, as string). */
   unitPrice: string;
   /** Total proceeds from selling (stroops, as string). */
   totalProceeds: string;
}

export interface KeyPriceResult {
   keyId: string;
   quantity: number;
   currentSupply: string;
   /** Buy-side pricing. */
   buy: KeyPriceBuySide;
   /**
    * Sell-side pricing, or null when quantity exceeds the circulating supply
    * (i.e. selling that many keys is impossible).
    */
   sell: KeyPriceSellSide | null;
   /**
    * Percentage by which the average unit buy-price deviates from the current
    * spot price.  Expressed as a signed decimal string, e.g. "2.35".
    * Positive means buying pushes price up.
    */
   priceImpactPercent: string;
}

/**
 * Return price data for `quantity` keys on the bonding curve of `keyId`.
 *
 * Resolves `keyId` by database id **or** handle (same as simulate endpoint).
 * Throws {@link KeyNotFoundError} when no matching profile exists.
 *
 * @param keyId   - Creator profile id or handle.
 * @param quantity - Number of keys to price (1..1_000_000).
 */
export async function getKeyPrice(
   keyId: string,
   quantity: number
): Promise<KeyPriceResult> {
   const cacheKey = `cache:keys:price:${keyId}:${quantity}`;

   // ── Cache read ────────────────────────────────────────
   try {
      const cached = await cacheGetJson<KeyPriceResult>(cacheKey);
      if (cached !== null) {
         return cached;
      }
   } catch (err) {
      logger.warn({ err, keyId, quantity }, 'Failed to read key price from cache');
   }

   // ── DB lookup ─────────────────────────────────────────
   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
   });

   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const currentSupply = Number(creator.circulatingSupply);

   // Validate milestones from DB (integer thresholds/exponents >= 0, sorted)
   const creatorRecord = creator as Record<string, unknown>;
   const milestones: Milestone[] = validateMilestones(
      creatorRecord.curveMilestones ?? []
   );
   const rawBaseExponent = creatorRecord.baseExponent;
   const baseExponent: number =
      typeof rawBaseExponent === 'number' && Number.isInteger(rawBaseExponent) && rawBaseExponent >= 0
         ? rawBaseExponent
         : 1;

   logger.info(
      { operation: 'key_price', keyId: creator.id, quantity, currentSupply },
      'Computing key price'
   );

   // ── Spot price at current supply (uses milestone-based exponent) ──
   const currentSpot = spotPrice(currentSupply, milestones, baseExponent);

   // ── Buy side ──────────────────────────────────────────
   const totalBuyCost = buyCost(currentSupply, quantity, milestones, baseExponent);
   const buyUnitPrice = quantity > 0 ? totalBuyCost / BigInt(quantity) : 0n;

   // ── Sell side (null when impossible) ─────────────────
   let sell: KeyPriceSellSide | null = null;
   if (quantity <= currentSupply) {
      const totalSellProceeds = sellProceeds(currentSupply, quantity, milestones, baseExponent);
      const sellUnitPrice = quantity > 0 ? totalSellProceeds / BigInt(quantity) : 0n;
      sell = {
         unitPrice: sellUnitPrice.toString(),
         totalProceeds: totalSellProceeds.toString(),
      };
   }

   // ── Price impact (buy side, vs spot) ──────────────────
   let priceImpactPercent = '0.00';
   if (currentSpot > 0n) {
      const spotNum = Number(currentSpot);
      const unitNum = Number(buyUnitPrice);
      priceImpactPercent = (((unitNum - spotNum) / spotNum) * 100).toFixed(2);
   }

   const result: KeyPriceResult = {
      keyId: creator.id,
      quantity,
      currentSupply: currentSupply.toString(),
      buy: {
         unitPrice: buyUnitPrice.toString(),
         totalCost: totalBuyCost.toString(),
      },
      sell,
      priceImpactPercent,
   };

   // ── Cache write (best-effort) ─────────────────────────
   try {
      await cacheSetJson(cacheKey, result, PRICE_CACHE_TTL_SECONDS);
   } catch (err) {
      logger.warn({ err, keyId, quantity }, 'Failed to cache key price result');
   }

   return result;
}
