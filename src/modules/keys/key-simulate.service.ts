import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';

import { KeyNotFoundError } from './key-fees.service';

export type SimulateSide = 'buy' | 'sell';

export interface SingleSimulation {
   quantity: number;
   totalCost: string;
   pricePerUnit: string;
   priceImpact: string;
   startPrice: string;
   endPrice: string;
}

export interface SimulateTradeResult {
   keyId: string;
   side: SimulateSide;
   circulatingSupply: number;
   simulations: SingleSimulation[];
}

export class InsufficientCirculatingSupplyError extends Error {
   constructor(message: string = 'Sell quantity exceeds circulating supply') {
      super(message);
      this.name = 'InsufficientCirculatingSupplyError';
   }
}

export class QuantityExceedsLimitError extends Error {
   constructor(message: string = 'Quantity exceeds maximum allowed limit (1,000,000)') {
      super(message);
      this.name = 'QuantityExceedsLimitError';
   }
}

export class BatchSizeExceedsLimitError extends Error {
   constructor(message: string = 'Maximum 20 quantities allowed per simulation request') {
      super(message);
      this.name = 'BatchSizeExceedsLimitError';
   }
}

const SIMULATE_CACHE_TTL_SECONDS = 15;
const MAX_QUANTITY = 1_000_000;
const MAX_BATCH_SIZE = 20;

/**
 * Calculates spot price at supply `s` given base price and exponent: P(s) = basePrice * (s ^ exponent).
 */
function getSpotPrice(supply: number, exponent: number = 1): bigint {
   if (supply <= 0) return 1_000_000n; // Base 0.1 XLM in stroops (7 decimals)
   return 1_000_000n + BigInt(Math.floor(Math.pow(supply, exponent) * 100_000));
}

/**
 * Constant-time calculation for total cost between s0 and s1:
 * Integrates P(s) = base + k * s^e -> base * (s1 - s0) + k / (e + 1) * (s1^(e+1) - s0^(e+1)).
 */
function computeCostInterval(s0: number, s1: number, exponent: number = 1): bigint {
   if (s1 <= s0) return 0n;
   const basePart = 1_000_000n * BigInt(s1 - s0);
   const expPlusOne = exponent + 1;
   const powerDiff = Math.pow(s1, expPlusOne) - Math.pow(s0, expPlusOne);
   const curvePart = BigInt(Math.floor((100_000 / expPlusOne) * powerDiff));
   return basePart + curvePart;
}

/**
 * Computes buy cost in constant time using piecewise integration across milestones.
 */
function computeBuyCostConstantTime(
   currentSupply: number,
   quantity: number,
   milestones: Array<{ supplyThreshold: number; exponent: number }> = [],
   baseExponent: number = 1
): bigint {
   let remaining = quantity;
   let s = currentSupply;
   let total = 0n;

   const sortedMilestones = [...milestones].sort((a, b) => a.supplyThreshold - b.supplyThreshold);

   for (const m of sortedMilestones) {
      if (remaining <= 0) break;
      if (s < m.supplyThreshold) {
         const segment = Math.min(remaining, m.supplyThreshold - s);
         total += computeCostInterval(s, s + segment, m.exponent);
         s += segment;
         remaining -= segment;
      }
   }

   if (remaining > 0) {
      total += computeCostInterval(s, s + remaining, baseExponent);
   }

   return total;
}

/**
 * Computes sell payout in constant time using piecewise integration.
 */
function computeSellPayoutConstantTime(
   currentSupply: number,
   quantity: number,
   milestones: Array<{ supplyThreshold: number; exponent: number }> = [],
   baseExponent: number = 1
): bigint {
   let remaining = quantity;
   let s = currentSupply;
   let total = 0n;

   const sortedMilestones = [...milestones].sort((a, b) => b.supplyThreshold - a.supplyThreshold);

   for (const m of sortedMilestones) {
      if (remaining <= 0) break;
      if (s > m.supplyThreshold) {
         const segment = Math.min(remaining, s - m.supplyThreshold);
         total += computeCostInterval(s - segment, s, m.exponent);
         s -= segment;
         remaining -= segment;
      }
   }

   if (remaining > 0) {
      const segment = Math.min(remaining, s);
      total += computeCostInterval(s - segment, s, baseExponent);
   }

   return total;
}

export async function simulateKeyTrade(
   keyId: string,
   quantities: number[],
   side: SimulateSide
): Promise<SimulateTradeResult> {
   if (quantities.length > MAX_BATCH_SIZE) {
      throw new BatchSizeExceedsLimitError();
   }

   for (const q of quantities) {
      if (q > MAX_QUANTITY) {
         throw new QuantityExceedsLimitError();
      }
   }

   const sortedKey = quantities.slice().sort((a, b) => a - b).join(',');
   const cacheKey = `cache:keys:simulate:${keyId}:${side}:${sortedKey}`;
   const cached = await cacheGetJson<SimulateTradeResult>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
   });

   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const currentSupply = Number(creator.circulatingSupply);
   const milestones = ((creator as any).curveMilestones as any) ?? [];
   const baseExponent = ((creator as any).baseExponent as number) ?? 1;

   logger.info(
      {
         operation: side === 'buy' ? 'simulate_buy_preview' : 'simulate_sell_preview',
         keyId: creator.id,
         quantities,
         currentSupply,
      },
      `Simulating ${side} preview for key`
   );

   const simulations: SingleSimulation[] = [];

   for (const q of quantities) {
      if (side === 'sell' && q > currentSupply) {
         throw new InsufficientCirculatingSupplyError(
            `Requested sell quantity (${q}) exceeds circulating supply (${currentSupply})`
         );
      }

      const startPrice = getSpotPrice(currentSupply, baseExponent);
      let totalAmount: bigint;
      let endPrice: bigint;

      if (side === 'buy') {
         totalAmount = computeBuyCostConstantTime(currentSupply, q, milestones, baseExponent);
         endPrice = getSpotPrice(currentSupply + q, baseExponent);
      } else {
         totalAmount = computeSellPayoutConstantTime(currentSupply, q, milestones, baseExponent);
         endPrice = getSpotPrice(Math.max(0, currentSupply - q), baseExponent);
      }

      const pricePerUnit = (totalAmount / BigInt(q)).toString();
      const startPriceNum = Number(startPrice);
      const endPriceNum = Number(endPrice);
      const impactPct = startPriceNum > 0
         ? (((endPriceNum - startPriceNum) / startPriceNum) * 100).toFixed(2)
         : '0.00';

      simulations.push({
         quantity: q,
         totalCost: totalAmount.toString(),
         pricePerUnit,
         priceImpact: `${impactPct}%`,
         startPrice: startPrice.toString(),
         endPrice: endPrice.toString(),
      });
   }

   const result: SimulateTradeResult = {
      keyId: creator.id,
      side,
      circulatingSupply: currentSupply,
      simulations,
   };

   await cacheSetJson(cacheKey, result, SIMULATE_CACHE_TTL_SECONDS);
   return result;
}
