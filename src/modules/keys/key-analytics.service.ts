// src/modules/keys/key-analytics.service.ts
// Trade count, unique trader, and volume analytics per creator key and
// platform-wide (#916). Sourced from the Trade table, which the trade indexer
// populates from on-chain buy events. Results are cached for 60s per key and
// time window; the trade indexer invalidates them on every new trade.
import { z } from 'zod';
import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheInvalidate,
   cacheSetJson,
} from '../../utils/redis.utils';
import { KeyNotFoundError } from './key-fees.service';

export const KEY_ANALYTICS_CACHE_TTL_SECONDS = 60;

export interface AnalyticsWindow {
   from?: Date;
   to?: Date;
}

/** Optional ISO-8601 `from` / `to` query params bounding Trade.timestamp. */
export const analyticsWindowQuerySchema = z
   .object({
      from: z.string().datetime().optional(),
      to: z.string().datetime().optional(),
   })
   .refine(q => !q.from || !q.to || new Date(q.from) <= new Date(q.to), {
      message: 'from must be before or equal to to',
      path: ['from'],
   })
   .transform(
      (q): AnalyticsWindow => ({
         from: q.from ? new Date(q.from) : undefined,
         to: q.to ? new Date(q.to) : undefined,
      })
   );

export interface TradeStats {
   trade_count: number;
   unique_traders: number;
   total_volume: string;
}

export interface KeyAnalytics extends TradeStats {
   keyId: string;
   from: string | null;
   to: string | null;
}

export interface PlatformAnalytics extends TradeStats {
   key_count: number;
   from: string | null;
   to: string | null;
}

export interface PaymentAssetStats {
   payment_asset: string;
   trade_count: number;
   unique_traders: number;
   total_volume: string;
   trade_share_percent: number;
}

export interface KeyPaymentAssetAnalytics {
   keyId: string;
   assets: PaymentAssetStats[];
}

export interface PlatformPaymentAssetDistribution {
   assets: PaymentAssetStats[];
}

function windowSuffix(window: AnalyticsWindow): string {
   return `${window.from?.toISOString() ?? '-'}:${window.to?.toISOString() ?? '-'}`;
}

export function getKeyAnalyticsCacheKey(
   keyId: string,
   window: AnalyticsWindow = {}
): string {
   return `key:analytics:${keyId}:${windowSuffix(window)}`;
}

export function getPlatformAnalyticsCacheKey(
   window: AnalyticsWindow = {}
): string {
   return `platform:analytics:${windowSuffix(window)}`;
}

/**
 * Drop every cached analytics window for the key, plus every platform
 * aggregate window, since a new trade changes both.
 */
export async function invalidateKeyAnalyticsCache(
   keyId: string
): Promise<void> {
   await cacheInvalidate(
      `key:analytics:${keyId}:*`,
      `key:payment-asset-analytics:${keyId}`,
      'platform:analytics:*',
      'platform:payment-asset-distribution'
   );
}

function buildTimestampFilter(window: AnalyticsWindow) {
   if (!window.from && !window.to) return undefined;
   return {
      ...(window.from ? { gte: window.from } : {}),
      ...(window.to ? { lte: window.to } : {}),
   };
}

/**
 * Aggregate trade rows into count, distinct buyers, and volume
 * (sum of price * quantity, in the same base units as Trade.price).
 */
export function aggregateTrades(
   trades: Array<{ buyer: string; price: string; quantity: string }>
): TradeStats {
   const traders = new Set<string>();
   let volume = 0n;
   for (const trade of trades) {
      traders.add(trade.buyer);
      volume += BigInt(trade.price) * BigInt(trade.quantity);
   }
   return {
      trade_count: trades.length,
      unique_traders: traders.size,
      total_volume: volume.toString(),
   };
}

export async function getKeyAnalytics(
   keyId: string,
   window: AnalyticsWindow = {}
): Promise<KeyAnalytics> {
   const cacheKey = getKeyAnalyticsCacheKey(keyId, window);
   const cached = await cacheGetJson<KeyAnalytics>(cacheKey);
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

   const timestamp = buildTimestampFilter(window);
   const trades = await prisma.trade.findMany({
      where: { creatorId: keyId, ...(timestamp ? { timestamp } : {}) },
      select: { buyer: true, price: true, quantity: true },
   });

   const analytics: KeyAnalytics = {
      keyId,
      ...aggregateTrades(trades),
      from: window.from?.toISOString() ?? null,
      to: window.to?.toISOString() ?? null,
   };

   await cacheSetJson(cacheKey, analytics, KEY_ANALYTICS_CACHE_TTL_SECONDS);
   return analytics;
}

export async function getPlatformAnalytics(
   window: AnalyticsWindow = {}
): Promise<PlatformAnalytics> {
   const cacheKey = getPlatformAnalyticsCacheKey(window);
   const cached = await cacheGetJson<PlatformAnalytics>(cacheKey);
   if (cached) {
      return cached;
   }

   const timestamp = buildTimestampFilter(window);
   const trades = await prisma.trade.findMany({
      where: timestamp ? { timestamp } : {},
      select: { buyer: true, creatorId: true, price: true, quantity: true },
   });

   const analytics: PlatformAnalytics = {
      ...aggregateTrades(trades),
      key_count: new Set(trades.map(t => t.creatorId)).size,
      from: window.from?.toISOString() ?? null,
      to: window.to?.toISOString() ?? null,
   };

   await cacheSetJson(cacheKey, analytics, KEY_ANALYTICS_CACHE_TTL_SECONDS);
   return analytics;
}

function aggregatePaymentAssets(
   trades: Array<{
      buyer: string;
      price: string;
      quantity: string;
      paymentAsset: string;
   }>
): PaymentAssetStats[] {
   const groups = new Map<
      string,
      { buyers: Set<string>; tradeCount: number; volume: bigint }
   >();

   for (const trade of trades) {
      const asset = trade.paymentAsset || 'XLM';
      const group = groups.get(asset) ?? {
         buyers: new Set<string>(),
         tradeCount: 0,
         volume: 0n,
      };
      group.buyers.add(trade.buyer);
      group.tradeCount += 1;
      group.volume += BigInt(trade.price) * BigInt(trade.quantity);
      groups.set(asset, group);
   }

   return [...groups.entries()]
      .map(([payment_asset, group]) => ({
         payment_asset,
         trade_count: group.tradeCount,
         unique_traders: group.buyers.size,
         total_volume: group.volume.toString(),
         trade_share_percent: trades.length
            ? Number((BigInt(group.tradeCount) * 10000n) / BigInt(trades.length)) /
              100
            : 0,
      }))
      .sort((a, b) => a.payment_asset.localeCompare(b.payment_asset));
}

export async function getKeyPaymentAssetAnalytics(
   keyId: string
): Promise<KeyPaymentAssetAnalytics> {
   const cacheKey = `key:payment-asset-analytics:${keyId}`;
   const cached = await cacheGetJson<KeyPaymentAssetAnalytics>(cacheKey);
   if (cached) return cached;

   const creator = await prisma.creatorProfile.findUnique({
      where: { id: keyId },
      select: { id: true },
   });
   if (!creator) throw new KeyNotFoundError(keyId);

   const trades = await prisma.trade.findMany({
      where: { creatorId: creator.id },
      select: { buyer: true, price: true, quantity: true, paymentAsset: true },
   });
   const analytics = { keyId: creator.id, assets: aggregatePaymentAssets(trades) };

   await cacheSetJson(cacheKey, analytics, KEY_ANALYTICS_CACHE_TTL_SECONDS);
   return analytics;
}

export async function getPlatformPaymentAssetDistribution(): Promise<PlatformPaymentAssetDistribution> {
   const cacheKey = 'platform:payment-asset-distribution';
   const cached = await cacheGetJson<PlatformPaymentAssetDistribution>(cacheKey);
   if (cached) return cached;

   const trades = await prisma.trade.findMany({
      select: { buyer: true, price: true, quantity: true, paymentAsset: true },
   });
   const distribution = { assets: aggregatePaymentAssets(trades) };

   await cacheSetJson(cacheKey, distribution, KEY_ANALYTICS_CACHE_TTL_SECONDS);
   return distribution;
}
