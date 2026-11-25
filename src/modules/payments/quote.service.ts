// src/modules/payments/quote.service.ts
// Multi-asset conversion quote service (#1309).
//
// Uses pure BigInt integer arithmetic with 7-decimal internal precision
// (10_000_000 = 1.0 base unit) and rounds in the protocol's favor.

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';
import { buyCost, validateMilestones } from '../../utils/bonding-curve.utils';
import { logger } from '../../utils/logger.utils';

export const INTERNAL_PRECISION_DECIMALS = 7;
export const INTERNAL_SCALE = 10_000_000n;
export const RATE_CACHE_TTL_SECONDS = 5;
export const DEFAULT_MAX_ORACLE_AGE_SECONDS = 60;
export const DEFAULT_SLIPPAGE_BPS = 100; // 1%
export const DEFAULT_PROTOCOL_FEE_BPS = 250; // 2.5%

export interface AssetConversionDescriptor {
   symbol: string;
   decimals: number;
   /** Price of 1 whole unit of this asset in XLM, scaled to 7 decimals. */
   rate7: bigint;
}

export interface OracleRateReading {
   /** Price of 1 whole unit of the asset in XLM, scaled to 7 decimals. */
   rate7: bigint;
   /** Timestamp when the oracle produced this rate. */
   updatedAt: Date;
   /** Optional source label (e.g. 'soroban_oracle'). */
   source?: string;
}

export type OracleRateFetcher = (asset: {
   token: string;
   symbol: string;
   oracle: string | null;
}) => Promise<OracleRateReading | null>;

export interface AssetRateSnapshot {
   token: string;
   symbol: string;
   decimals: number;
   oracle: string | null;
   rate7: bigint;
   rateFormatted: string;
   rateAgeSeconds: number;
   stale: boolean;
   fallbackSource: string | null;
   fetchedAt: string;
}

export interface BuyQuoteResult {
   keyId: string;
   quantity: number;
   asset: {
      token: string;
      symbol: string;
      decimals: number;
   };
   cost: string;
   fees: {
      protocolFee: string;
      creatorFee: string;
      totalFee: string;
   };
   total: string;
   costXlmStroops: string;
   rateUsed: string;
   rateAgeSeconds: number;
   stale: boolean;
   fallbackSource: string | null;
   slippageBps: number;
   recommendedMaxPay: string;
}

interface CachedRatePayload {
   rate7: string;
   updatedAt: string;
   fallbackSource: string | null;
   fetchedAt: string;
}

export class PaymentAssetNotFoundError extends Error {
   constructor(asset: string) {
      super(`Payment asset not found or disabled: ${asset}`);
      this.name = 'PaymentAssetNotFoundError';
   }
}

export class KeyNotFoundForQuoteError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'KeyNotFoundForQuoteError';
   }
}

export class InvalidQuoteInputError extends Error {
   constructor(message: string) {
      super(message);
      this.name = 'InvalidQuoteInputError';
   }
}

/** Integer ceiling division for non-negative numerator and positive denominator. */
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
   if (denominator <= 0n) {
      throw new InvalidQuoteInputError('Denominator must be positive');
   }
   if (numerator < 0n) {
      throw new InvalidQuoteInputError('Numerator must be non-negative');
   }
   if (numerator === 0n) return 0n;
   return (numerator + denominator - 1n) / denominator;
}

/** Integer floor division for non-negative numerator and positive denominator. */
export function floorDiv(numerator: bigint, denominator: bigint): bigint {
   if (denominator <= 0n) {
      throw new InvalidQuoteInputError('Denominator must be positive');
   }
   if (numerator < 0n) {
      throw new InvalidQuoteInputError('Numerator must be non-negative');
   }
   return numerator / denominator;
}

/** Format a BigInt integer amount with `decimals` decimal places. */
export function formatTokenAmount(amount: bigint, decimals: number): string {
   if (decimals <= 0) return amount.toString();
   const scale = 10n ** BigInt(decimals);
   const whole = amount / scale;
   const frac = (amount % scale).toString().padStart(decimals, '0');
   return `${whole}.${frac}`;
}

function rateCacheKey(token: string): string {
   return `payment_asset:rate:${token}`;
}

export class QuoteService {
   private readonly oracleFetcher?: OracleRateFetcher;
   private readonly maxOracleAgeSeconds: number;
   private readonly now: () => Date;
   private readonly memoryCache = new Map<
      string,
      { payload: CachedRatePayload; expiresAtMs: number }
   >();

   constructor(options?: {
      oracleFetcher?: OracleRateFetcher;
      maxOracleAgeSeconds?: number;
      now?: () => Date;
   }) {
      this.oracleFetcher = options?.oracleFetcher;
      this.maxOracleAgeSeconds =
         options?.maxOracleAgeSeconds ?? DEFAULT_MAX_ORACLE_AGE_SECONDS;
      this.now = options?.now ?? (() => new Date());
   }

   /**
    * Converts `amount` (in `from.decimals` integer units) to `to.decimals`
    * integer units via 7-decimal internal precision.
    *
    * By default (`roundInProtocolFavor = true`), intermediate and final
    * divisions round UP (ceiling) so the protocol never receives less than
    * the exact conversion value. Pass `roundInProtocolFavor = false` to
    * round down (e.g. for user payouts).
    */
   static convert(
      amount: bigint,
      from: AssetConversionDescriptor,
      to: AssetConversionDescriptor,
      roundInProtocolFavor = true
   ): bigint {
      if (amount < 0n) {
         throw new InvalidQuoteInputError('Amount must be non-negative');
      }
      if (from.rate7 <= 0n || to.rate7 <= 0n) {
         throw new InvalidQuoteInputError('Asset rates must be positive');
      }
      if (from.decimals < 0 || to.decimals < 0) {
         throw new InvalidQuoteInputError('Asset decimals must be non-negative');
      }
      if (amount === 0n) return 0n;

      if (
         from.symbol === to.symbol &&
         from.decimals === to.decimals &&
         from.rate7 === to.rate7
      ) {
         return amount;
      }

      const div = roundInProtocolFavor ? ceilDiv : floorDiv;

      // Step 1: Convert `from` raw units -> 7-decimal internal precision base units.
      const fromScale = 10n ** BigInt(from.decimals);
      const internalBase7 = div(amount * from.rate7, fromScale);

      // Step 2: Convert 7-decimal internal precision base units -> `to` raw units.
      const toScale = 10n ** BigInt(to.decimals);
      return div(internalBase7 * toScale, to.rate7);
   }

   async invalidateRateCache(token?: string): Promise<void> {
      if (token) {
         this.memoryCache.delete(token);
         await cacheInvalidate(rateCacheKey(token));
      } else {
         this.memoryCache.clear();
         await cacheInvalidate('payment_asset:rate:*');
      }
   }

   async getAssetRate(asset: {
      token: string;
      symbol: string;
      decimals: number;
      oracle: string | null;
      rate7: bigint | null;
      rateUpdatedAt: Date | null;
   }): Promise<AssetRateSnapshot> {
      const now = this.now();
      const cacheKey = rateCacheKey(asset.token);

      // Native XLM always has a 1:1 rate (10_000_000n in 7-decimal precision).
      if (asset.token === 'native' || asset.symbol.toUpperCase() === 'XLM') {
         return {
            token: asset.token,
            symbol: asset.symbol,
            decimals: asset.decimals,
            oracle: asset.oracle,
            rate7: INTERNAL_SCALE,
            rateFormatted: formatTokenAmount(
               INTERNAL_SCALE,
               INTERNAL_PRECISION_DECIMALS
            ),
            rateAgeSeconds: 0,
            stale: false,
            fallbackSource: null,
            fetchedAt: now.toISOString(),
         };
      }

      // 1. Check 5-second memory + Redis cache
      const mem = this.memoryCache.get(asset.token);
      if (mem && mem.expiresAtMs > now.getTime()) {
         return this.buildRateSnapshot(asset, mem.payload, now);
      }

      const redisCached = await cacheGetJson<CachedRatePayload>(cacheKey);
      if (redisCached) {
         this.memoryCache.set(asset.token, {
            payload: redisCached,
            expiresAtMs: now.getTime() + RATE_CACHE_TTL_SECONDS * 1000,
         });
         return this.buildRateSnapshot(asset, redisCached, now);
      }

      // 2. Fetch from primary oracle if available, otherwise fall back to DB rate
      let rate7: bigint | null = null;
      let updatedAt: Date | null = null;
      let fallbackSource: string | null = null;

      if (this.oracleFetcher) {
         try {
            const reading = await this.oracleFetcher({
               token: asset.token,
               symbol: asset.symbol,
               oracle: asset.oracle,
            });
            if (reading && reading.rate7 > 0n) {
               rate7 = reading.rate7;
               updatedAt = reading.updatedAt;
            }
         } catch (error) {
            logger.warn(
               {
                  token: asset.token,
                  symbol: asset.symbol,
                  error: error instanceof Error ? error.message : String(error),
               },
               'Oracle rate fetch failed; attempting fallback rate'
            );
         }
      }

      if (rate7 === null && asset.rate7 !== null && asset.rate7 > 0n) {
         rate7 = asset.rate7;
         updatedAt = asset.rateUpdatedAt ?? new Date(0);
         fallbackSource = 'db_last_known';
      }

      if (rate7 === null) {
         throw new InvalidQuoteInputError(
            `No oracle or fallback rate available for asset ${asset.symbol}`
         );
      }

      const payload: CachedRatePayload = {
         rate7: rate7.toString(),
         updatedAt: (updatedAt ?? now).toISOString(),
         fallbackSource,
         fetchedAt: now.toISOString(),
      };

      this.memoryCache.set(asset.token, {
         payload,
         expiresAtMs: now.getTime() + RATE_CACHE_TTL_SECONDS * 1000,
      });
      await cacheSetJson(cacheKey, payload, RATE_CACHE_TTL_SECONDS);

      return this.buildRateSnapshot(asset, payload, now);
   }

   private buildRateSnapshot(
      asset: {
         token: string;
         symbol: string;
         decimals: number;
         oracle: string | null;
      },
      payload: CachedRatePayload,
      now: Date
   ): AssetRateSnapshot {
      const rate7 = BigInt(payload.rate7);
      const updatedAtMs = new Date(payload.updatedAt).getTime();
      const rateAgeSeconds = Math.max(
         0,
         Math.floor((now.getTime() - updatedAtMs) / 1000)
      );
      const stale =
         payload.fallbackSource !== null ||
         rateAgeSeconds > this.maxOracleAgeSeconds;

      return {
         token: asset.token,
         symbol: asset.symbol,
         decimals: asset.decimals,
         oracle: asset.oracle,
         rate7,
         rateFormatted: formatTokenAmount(rate7, INTERNAL_PRECISION_DECIMALS),
         rateAgeSeconds,
         stale,
         fallbackSource: payload.fallbackSource,
         fetchedAt: payload.fetchedAt,
      };
   }

   async listEnabledAssets(): Promise<AssetRateSnapshot[]> {
      const assets = await prisma.paymentAsset.findMany({
         where: { enabled: true },
         orderBy: { symbol: 'asc' },
      });

      const results: AssetRateSnapshot[] = [];
      for (const asset of assets) {
         results.push(await this.getAssetRate(asset));
      }
      return results;
   }

   async getBuyQuote(params: {
      keyId: string;
      quantity: number;
      asset: string;
      slippageBps?: number;
   }): Promise<BuyQuoteResult> {
      const { keyId, quantity, asset: assetQuery } = params;
      const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;

      if (!Number.isInteger(quantity) || quantity <= 0) {
         throw new InvalidQuoteInputError('quantity must be a positive integer');
      }
      if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) {
         throw new InvalidQuoteInputError(
            'slippageBps must be an integer between 0 and 5000'
         );
      }

      const creator = await prisma.creatorProfile.findFirst({
         where: { OR: [{ id: keyId }, { handle: keyId }] },
         select: {
            id: true,
            circulatingSupply: true,
            curveMilestones: true,
            baseExponent: true,
            creatorRoyaltyBuyBps: true,
         },
      });

      if (!creator) {
         throw new KeyNotFoundForQuoteError(keyId);
      }

      const paymentAsset = await prisma.paymentAsset.findFirst({
         where: {
            enabled: true,
            OR: [
               { token: assetQuery },
               { symbol: { equals: assetQuery, mode: 'insensitive' } },
            ],
         },
      });

      if (!paymentAsset) {
         throw new PaymentAssetNotFoundError(assetQuery);
      }

      const rateSnapshot = await this.getAssetRate(paymentAsset);

      // Compute bonding curve cost in 7-decimal XLM stroops
      const currentSupply = Math.max(0, Math.floor(Number(creator.circulatingSupply)));
      const milestones = validateMilestones(creator.curveMilestones);
      const costStroops = buyCost(
         currentSupply,
         quantity,
         milestones,
         creator.baseExponent
      );

      const protocolFeeStroops = ceilDiv(
         costStroops * BigInt(DEFAULT_PROTOCOL_FEE_BPS),
         10_000n
      );
      const creatorFeeStroops = ceilDiv(
         costStroops * BigInt(Math.max(0, creator.creatorRoyaltyBuyBps)),
         10_000n
      );
      const totalStroops = costStroops + protocolFeeStroops + creatorFeeStroops;

      const xlmDescriptor: AssetConversionDescriptor = {
         symbol: 'XLM',
         decimals: INTERNAL_PRECISION_DECIMALS,
         rate7: INTERNAL_SCALE,
      };
      const targetDescriptor: AssetConversionDescriptor = {
         symbol: rateSnapshot.symbol,
         decimals: rateSnapshot.decimals,
         rate7: rateSnapshot.rate7,
      };

      const convertedCost = QuoteService.convert(
         costStroops,
         xlmDescriptor,
         targetDescriptor,
         true
      );
      const convertedProtocolFee = QuoteService.convert(
         protocolFeeStroops,
         xlmDescriptor,
         targetDescriptor,
         true
      );
      const convertedCreatorFee = QuoteService.convert(
         creatorFeeStroops,
         xlmDescriptor,
         targetDescriptor,
         true
      );
      const convertedTotalFee = convertedProtocolFee + convertedCreatorFee;
      const convertedTotal = QuoteService.convert(
         totalStroops,
         xlmDescriptor,
         targetDescriptor,
         true
      );

      const recommendedMaxPay = ceilDiv(
         convertedTotal * BigInt(10_000 + slippageBps),
         10_000n
      );

      return {
         keyId: creator.id,
         quantity,
         asset: {
            token: rateSnapshot.token,
            symbol: rateSnapshot.symbol,
            decimals: rateSnapshot.decimals,
         },
         cost: convertedCost.toString(),
         fees: {
            protocolFee: convertedProtocolFee.toString(),
            creatorFee: convertedCreatorFee.toString(),
            totalFee: convertedTotalFee.toString(),
         },
         total: convertedTotal.toString(),
         costXlmStroops: costStroops.toString(),
         rateUsed: rateSnapshot.rateFormatted,
         rateAgeSeconds: rateSnapshot.rateAgeSeconds,
         stale: rateSnapshot.stale,
         fallbackSource: rateSnapshot.fallbackSource,
         slippageBps,
         recommendedMaxPay: recommendedMaxPay.toString(),
      };
   }
}

export const quoteService = new QuoteService();
