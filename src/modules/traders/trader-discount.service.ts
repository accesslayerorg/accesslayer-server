import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
} from '../../utils/redis.utils';
import { computeWallet30dVolume } from '../../utils/trading-volume.utils';
import { loadFeeTierConfig } from '../protocol/fee-tier.service';
import { logger } from '../../utils/logger.utils';

export const TRADER_DISCOUNT_CACHE_TTL_SECONDS = 300; // 5 minutes
export const DEFAULT_BASE_PROTOCOL_FEE_BPS = 500;

export interface VolumeDiscountTierChangedEvent {
   txHash: string;
   ledger: number;
   eventIndex?: number;
   wallet: string;
   tier: string;
   discountBps: number;
   volume30dStroops?: string;
}

export interface TraderDiscountInfo {
   wallet: string;
   tier: string;
   discountBps: number;
   volume30dStroops: string;
   cached: boolean;
}

const indexedEventKeys = new Set<string>();
const indexedWalletTierOverrides = new Map<
   string,
   { tier: string; discountBps: number; ledger: number }
>();

function discountCacheKey(wallet: string): string {
   return `trader:discount:${wallet}`;
}

export function resetTraderDiscountStateForTests(): void {
   indexedEventKeys.clear();
   indexedWalletTierOverrides.clear();
}

/**
 * Indexes `VolumeDiscountTierChanged` contract events without duplication
 * and invalidates the affected wallet's 5-minute discount cache.
 */
export async function indexVolumeDiscountTierChangedEvent(
   event: VolumeDiscountTierChangedEvent
): Promise<{ indexed: boolean; duplicate: boolean }> {
   const dedupKey = `${event.txHash}:${event.ledger}:${event.eventIndex ?? 0}:${event.wallet}`;
   if (indexedEventKeys.has(dedupKey)) {
      return { indexed: false, duplicate: true };
   }

   indexedEventKeys.add(dedupKey);
   indexedWalletTierOverrides.set(event.wallet, {
      tier: event.tier,
      discountBps: event.discountBps,
      ledger: event.ledger,
   });

   await cacheInvalidate(discountCacheKey(event.wallet));

   logger.info(
      {
         wallet: event.wallet,
         tier: event.tier,
         discountBps: event.discountBps,
         ledger: event.ledger,
      },
      'Indexed VolumeDiscountTierChanged event'
   );

   return { indexed: true, duplicate: false };
}

/**
 * Computes or retrieves the current fee discount tier, discount bps, and
 * rolling 30-day trading volume for a wallet, cached with a 5-minute TTL.
 */
export async function getTraderDiscount(
   wallet: string
): Promise<TraderDiscountInfo> {
   const cacheKey = discountCacheKey(wallet);
   const cached = await cacheGetJson<Omit<TraderDiscountInfo, 'cached'>>(
      cacheKey
   );
   if (cached !== null) {
      return {
         ...cached,
         cached: true,
      };
   }

   const volume30d = await computeWallet30dVolume(wallet);
   const tiers = await loadFeeTierConfig();

   const sortedDesc = [...tiers].sort(
      (a, b) => b.volumeThreshold - a.volumeThreshold
   );
   const matchedTier =
      sortedDesc.find(t => volume30d >= BigInt(t.volumeThreshold)) ??
      tiers[0] ?? {
         volumeThreshold: 0,
         feeBps: DEFAULT_BASE_PROTOCOL_FEE_BPS,
         label: 'TIER_1',
      };

   const baseFeeBps = tiers[0]?.feeBps ?? DEFAULT_BASE_PROTOCOL_FEE_BPS;
   let tierLabel = matchedTier.label;
   let discountBps = Math.max(0, baseFeeBps - matchedTier.feeBps);

   const override = indexedWalletTierOverrides.get(wallet);
   if (override && override.discountBps > discountBps) {
      tierLabel = override.tier;
      discountBps = override.discountBps;
   }

   const payload = {
      wallet,
      tier: tierLabel,
      discountBps,
      volume30dStroops: volume30d.toString(),
   };

   await cacheSetJson(cacheKey, payload, TRADER_DISCOUNT_CACHE_TTL_SECONDS);

   return {
      ...payload,
      cached: false,
   };
}
