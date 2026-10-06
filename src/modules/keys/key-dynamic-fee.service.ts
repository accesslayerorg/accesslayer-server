import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
// Removed unused import
import { computeWallet30dVolume } from '../../utils/trading-volume.utils';
import { loadFeeTierConfig } from '../protocol/fee-tier.service';
import { computeBuyCost, computeSellPayout } from '../../utils/pricing.utils';
import { KeyNotFoundError } from './key-fees.service';

export interface DynamicFeeConfig {
   baseFeeBps: number;
}

export interface DynamicFeeResult {
   components: {
      baseBps: number;
      volumeTierDiscountBps: number;
      protocolBps: number;
      royaltyBps: number;
   };
   effectiveRate: number;
   totals: {
      feeStroops: string; // "key units"
      feeUsd: string;
      totalCostStroops: string;
   };
}

/**
 * Fetch the fee configuration from the contract.
 * Cached with a 5-minute TTL as per requirements.
 */
export async function getFeeConfigFromContract(keyId: string): Promise<DynamicFeeConfig> {
   const cacheKey = `fee-config:${keyId}`;
   let config = await cacheGetJson<DynamicFeeConfig>(cacheKey);
   
   if (!config) {
      // Mocking the contract call for now by falling back to DB protocol config
      const dbConfig = await prisma.protocolConfig.findFirst();
      config = {
         baseFeeBps: dbConfig?.protocolFeeBps ?? 500,
      };
      
      // Cache with 5-minute TTL (300 seconds)
      await cacheSetJson(cacheKey, config, 300);
   }
   
   return config;
}

/**
 * Computes the effective dynamic fee rate and total costs for a trade.
 * 
 * @param keyId - The creator key ID to trade
 * @param amount - The number of keys to trade
 * @param direction - 'buy' or 'sell'
 * @param wallet - The wallet address executing the trade, used for 30d volume discount
 */
export async function getDynamicFeeRate(
   keyId: string,
   amount: number,
   direction: 'buy' | 'sell',
   wallet?: string
): Promise<DynamicFeeResult> {
   if (amount < 0) {
      throw new Error('Amount must be non-negative');
   }

   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: {
         id: true,
         circulatingSupply: true,
         creatorRoyaltyBuyBps: true,
         creatorRoyaltySellBps: true,
      },
   });
   
   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   // 1. Base Fee from Contract (Cached 5-min)
   const feeConfig = await getFeeConfigFromContract(creator.id);
   const baseFeeBps = feeConfig.baseFeeBps;

   // 2. Creator Royalty
   const royaltyBps = direction === 'buy' ? creator.creatorRoyaltyBuyBps : creator.creatorRoyaltySellBps;

   // 3. Protocol Fee & Volume Tier Discount
   let protocolFeeBps = baseFeeBps;
   if (wallet) {
      const volume30d = await computeWallet30dVolume(wallet);
      const tiers = await loadFeeTierConfig();
      
      // Find the highest threshold tier the wallet qualifies for
      const applicableTier = tiers
         .filter(t => BigInt(t.volumeThreshold) <= volume30d)
         .sort((a, b) => Number(BigInt(b.volumeThreshold) - BigInt(a.volumeThreshold)))[0];
         
      if (applicableTier && applicableTier.feeBps < baseFeeBps) {
         protocolFeeBps = applicableTier.feeBps;
      }
   }
   
   const volumeTierDiscountBps = Math.max(0, baseFeeBps - protocolFeeBps);
   
   // Effective Rate (Total BPS)
   const totalFeeBps = protocolFeeBps + royaltyBps;
   const effectiveRate = totalFeeBps / 10000;

   // 4. Compute Totals based on Bonding Curve
   const supply = Number(creator.circulatingSupply.toString());
   let feeStroops = 0n;
   let totalCostStroops = 0n;
   
   if (amount > 0) {
      if (direction === 'buy') {
         // compute base cost (0 fees)
         const baseCost = computeBuyCost(supply, amount, 0);
         feeStroops = (baseCost * BigInt(totalFeeBps)) / 10000n;
         totalCostStroops = baseCost + feeStroops;
      } else {
         if (amount > supply) {
            throw new Error('Cannot sell more keys than the current supply');
         }
         // compute base gross payout (0 fees)
         const grossPayout = computeSellPayout(supply, amount, 0); // note: computeSellPayout normally subtracts fees. With 0, it is gross.
         // fee is deducted from gross payout
         feeStroops = (grossPayout * BigInt(totalFeeBps)) / 10000n;
         totalCostStroops = grossPayout - feeStroops; // Net Payout
      }
   }

   // Optional USD conversion (returning 0 for now as placeholder for oracle integration)
   const feeUsd = "0.00"; 
   
   return {
      components: {
         baseBps: baseFeeBps,
         volumeTierDiscountBps: volumeTierDiscountBps,
         protocolBps: protocolFeeBps,
         royaltyBps: royaltyBps,
      },
      effectiveRate,
      totals: {
         feeStroops: feeStroops.toString(),
         feeUsd: feeUsd,
         totalCostStroops: totalCostStroops.toString(),
      }
   };
}
