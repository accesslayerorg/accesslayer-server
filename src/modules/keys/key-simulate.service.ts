import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import { computeBuyCost, computeSellPayout } from '../../utils/pricing.utils';

export type SimulateSide = 'buy' | 'sell';

export const SIMULATE_CACHE_TTL_SECONDS = 15;

export interface SingleSimulationResult {
   quantity: number;
   totalCost?: string;
   totalProceeds?: string;
   pricePerUnit: string;
   priceImpact: number;
}

export interface SimulateResponse {
   keyId: string;
   side: SimulateSide;
   spotPrice: string;
   quantity?: number;
   totalCost?: string;
   totalProceeds?: string;
   pricePerUnit?: string;
   priceImpact?: number;
   simulations?: SingleSimulationResult[];
}

export class KeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'KeyNotFoundError';
   }
}

export function buildSimulateCacheKey(
   keyId: string,
   quantitiesKey: string,
   side: SimulateSide
): string {
   return `key:simulate:${keyId}:${quantitiesKey}:${side}`;
}

export async function simulateKeyTrade(
   creatorId: string,
   quantities: number[],
   side: SimulateSide
): Promise<SimulateResponse> {
   const quantitiesKey = quantities.join(',');
   const cacheKey = buildSimulateCacheKey(creatorId, quantitiesKey, side);

   const cached = await cacheGetJson<SimulateResponse>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: creatorId }, { handle: creatorId }] },
      select: {
         id: true,
         circulatingSupply: true,
         creatorRoyaltyBuyBps: true,
         creatorRoyaltySellBps: true,
      },
   });

   if (!creator) {
      throw new KeyNotFoundError(creatorId);
   }

   const currentSupply = Number(creator.circulatingSupply);
   const spotPriceBigInt = computeBuyCost(currentSupply, 1, 0);
   const spotPriceNum = Number(spotPriceBigInt);

   const simulations: SingleSimulationResult[] = [];

   for (const qty of quantities) {
      if (side === 'buy') {
         logger.info(
            {
               operation: 'simulate_buy_contract_view',
               keyId: creator.id,
               quantity: qty,
               currentSupply,
            },
            'Calling simulate_buy contract view'
         );

         const totalCost = computeBuyCost(
            currentSupply,
            qty,
            creator.creatorRoyaltyBuyBps ?? 0
         );
         const pricePerUnit = Number(totalCost) / qty;
         const priceImpact =
            spotPriceNum > 0
               ? Number((((pricePerUnit - spotPriceNum) / spotPriceNum) * 100).toFixed(2))
               : 0;

         simulations.push({
            quantity: qty,
            totalCost: totalCost.toString(),
            pricePerUnit: Math.round(pricePerUnit).toString(),
            priceImpact,
         });
      } else {
         logger.info(
            {
               operation: 'simulate_sell_contract_view',
               keyId: creator.id,
               quantity: qty,
               currentSupply,
            },
            'Calling simulate_sell contract view'
         );

         const sellQty = Math.min(qty, currentSupply);
         const totalProceeds = computeSellPayout(
            currentSupply,
            sellQty,
            creator.creatorRoyaltySellBps ?? 0
         );
         const pricePerUnit = qty > 0 ? Number(totalProceeds) / qty : 0;
         const priceImpact =
            spotPriceNum > 0
               ? Number((((pricePerUnit - spotPriceNum) / spotPriceNum) * 100).toFixed(2))
               : 0;

         simulations.push({
            quantity: qty,
            totalProceeds: totalProceeds.toString(),
            pricePerUnit: Math.round(pricePerUnit).toString(),
            priceImpact,
         });
      }
   }

   let result: SimulateResponse;
   if (simulations.length === 1) {
      const sim = simulations[0];
      result = {
         keyId: creator.id,
         side,
         spotPrice: spotPriceBigInt.toString(),
         quantity: sim.quantity,
         ...(side === 'buy'
            ? { totalCost: sim.totalCost }
            : { totalProceeds: sim.totalProceeds }),
         pricePerUnit: sim.pricePerUnit,
         priceImpact: sim.priceImpact,
         simulations,
      };
   } else {
      result = {
         keyId: creator.id,
         side,
         spotPrice: spotPriceBigInt.toString(),
         simulations,
      };
   }

   await cacheSetJson(cacheKey, result, SIMULATE_CACHE_TTL_SECONDS);
   return result;
}
