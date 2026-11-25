// src/modules/payments/quote.service.test.ts
import {
   QuoteService,
   RATE_CACHE_TTL_SECONDS,
   PaymentAssetNotFoundError,
   KeyNotFoundForQuoteError,
   InvalidQuoteInputError,
} from './quote.service';
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      paymentAsset: {
         findMany: jest.fn(),
         findFirst: jest.fn(),
      },
      creatorProfile: {
         findFirst: jest.fn(),
      },
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn().mockResolvedValue(null),
   cacheSetJson: jest.fn().mockResolvedValue(undefined),
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));

describe('QuoteService (#1309)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      (cacheGetJson as jest.Mock).mockResolvedValue(null);
   });

   describe('QuoteService.convert', () => {
      it('converts across different decimals using 7-decimal precision and rounds up in protocol favor', () => {
         // 10_000_000 stroops (1.0 XLM, 7 decimals, rate 1.0 = 10_000_000)
         // -> USDC (6 decimals, rate 1 USDC = 2.0 XLM = 20_000_000)
         // 1 XLM = 0.5 USDC = 500_000 raw units
         const out = QuoteService.convert(
            10_000_000n,
            { symbol: 'XLM', decimals: 7, rate7: 10_000_000n },
            { symbol: 'USDC', decimals: 6, rate7: 20_000_000n }
         );
         expect(out).toBe(500_000n);
      });

      it('rounds UP in the protocol favor when division has a remainder', () => {
         // 1 stroop of XLM -> USDC (rate 3.0 XLM per USDC, 6 decimals):
         // step1: 1 * 10_000_000 / 10_000_000 = 1 base7 unit
         // step2: ceil(1 * 1_000_000 / 30_000_000) = 1 raw USDC unit
         const out = QuoteService.convert(
            1n,
            { symbol: 'XLM', decimals: 7, rate7: 10_000_000n },
            { symbol: 'USDC', decimals: 6, rate7: 30_000_000n },
            true
         );
         expect(out).toBe(1n);

         const outDown = QuoteService.convert(
            1n,
            { symbol: 'XLM', decimals: 7, rate7: 10_000_000n },
            { symbol: 'USDC', decimals: 6, rate7: 30_000_000n },
            false
         );
         expect(outDown).toBe(0n);
      });

      it('handles 18-decimal tokens without precision loss or float drift', () => {
         // 1.5 tokens (18 decimals) at rate 2.0 XLM -> 3.0 XLM = 30_000_000 stroops
         const out = QuoteService.convert(
            1_500_000_000_000_000_000n,
            { symbol: 'WETH', decimals: 18, rate7: 20_000_000n },
            { symbol: 'XLM', decimals: 7, rate7: 10_000_000n }
         );
         expect(out).toBe(30_000_000n);
      });

      it('throws on negative amounts or non-positive rates', () => {
         expect(() =>
            QuoteService.convert(
               -1n,
               { symbol: 'XLM', decimals: 7, rate7: 10_000_000n },
               { symbol: 'USDC', decimals: 6, rate7: 10_000_000n }
            )
         ).toThrow(InvalidQuoteInputError);

         expect(() =>
            QuoteService.convert(
               100n,
               { symbol: 'XLM', decimals: 7, rate7: 0n },
               { symbol: 'USDC', decimals: 6, rate7: 10_000_000n }
            )
         ).toThrow(InvalidQuoteInputError);
      });
   });

   describe('rate caching, staleness, and fallback', () => {
      it('caches oracle rates for 5 seconds', async () => {
         let nowMs = 1_700_000_000_000;
         const oracleFetcher = jest.fn().mockResolvedValue({
            rate7: 25_000_000n,
            updatedAt: new Date(nowMs - 5_000),
         });

         const service = new QuoteService({
            oracleFetcher,
            maxOracleAgeSeconds: 60,
            now: () => new Date(nowMs),
         });

         const asset = {
            token: 'CUSDC',
            symbol: 'USDC',
            decimals: 6,
            oracle: 'CORACLE',
            rate7: 20_000_000n,
            rateUpdatedAt: new Date(nowMs - 10_000),
         };

         const first = await service.getAssetRate(asset);
         expect(first.rate7).toBe(25_000_000n);
         expect(first.stale).toBe(false);
         expect(first.fallbackSource).toBeNull();
         expect(cacheSetJson).toHaveBeenCalledWith(
            'payment_asset:rate:CUSDC',
            expect.any(Object),
            RATE_CACHE_TTL_SECONDS
         );

         // Within 5s window: memory cache hit, oracleFetcher not called again
         nowMs += 3_000;
         const second = await service.getAssetRate(asset);
         expect(second.rate7).toBe(25_000_000n);
         expect(oracleFetcher).toHaveBeenCalledTimes(1);

         // After 5s window: cache expired, fetches again
         nowMs += 3_000;
         await service.getAssetRate(asset);
         expect(oracleFetcher).toHaveBeenCalledTimes(2);
      });

      it('marks quote stale when oracle age exceeds configured limit', async () => {
         const now = new Date('2026-11-24T12:00:00Z');
         const service = new QuoteService({
            oracleFetcher: jest.fn().mockResolvedValue({
               rate7: 25_000_000n,
               updatedAt: new Date(now.getTime() - 120_000), // 120s old > 60s limit
            }),
            maxOracleAgeSeconds: 60,
            now: () => now,
         });

         const snap = await service.getAssetRate({
            token: 'CUSDC',
            symbol: 'USDC',
            decimals: 6,
            oracle: 'CORACLE',
            rate7: null,
            rateUpdatedAt: null,
         });

         expect(snap.stale).toBe(true);
         expect(snap.rateAgeSeconds).toBe(120);
         expect(snap.fallbackSource).toBeNull();
      });

      it('uses fallback source and marks stale when oracle fails', async () => {
         const now = new Date('2026-11-24T12:00:00Z');
         const service = new QuoteService({
            oracleFetcher: jest.fn().mockRejectedValue(new Error('oracle down')),
            maxOracleAgeSeconds: 60,
            now: () => now,
         });

         const snap = await service.getAssetRate({
            token: 'CUSDC',
            symbol: 'USDC',
            decimals: 6,
            oracle: 'CORACLE',
            rate7: 20_000_000n,
            rateUpdatedAt: new Date(now.getTime() - 10_000),
         });

         expect(snap.rate7).toBe(20_000_000n);
         expect(snap.stale).toBe(true);
         expect(snap.fallbackSource).toBe('db_last_known');
      });
   });

   describe('getBuyQuote', () => {
      it('computes bonding-curve cost, fees, converted amounts, and recommendedMaxPay', async () => {
         (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({
            id: 'key-1',
            circulatingSupply: 0,
            curveMilestones: null,
            baseExponent: 1,
            creatorRoyaltyBuyBps: 500, // 5%
         });
         (prisma.paymentAsset.findFirst as jest.Mock).mockResolvedValue({
            token: 'native',
            symbol: 'XLM',
            decimals: 7,
            oracle: null,
            rate7: 10_000_000n,
            rateUpdatedAt: new Date(),
         });

         const service = new QuoteService();
         const quote = await service.getBuyQuote({
            keyId: 'key-1',
            quantity: 1,
            asset: 'XLM',
            slippageBps: 100,
         });

         expect(quote.keyId).toBe('key-1');
         expect(quote.asset.symbol).toBe('XLM');
         expect(BigInt(quote.cost)).toBeGreaterThan(0n);
         expect(BigInt(quote.fees.totalFee)).toBe(
            BigInt(quote.fees.protocolFee) + BigInt(quote.fees.creatorFee)
         );
         expect(BigInt(quote.recommendedMaxPay)).toBeGreaterThanOrEqual(
            BigInt(quote.total)
         );
      });

      it('throws KeyNotFoundForQuoteError or PaymentAssetNotFoundError when missing', async () => {
         (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue(null);
         const service = new QuoteService();

         await expect(
            service.getBuyQuote({ keyId: 'missing', quantity: 1, asset: 'XLM' })
         ).rejects.toThrow(KeyNotFoundForQuoteError);

         (prisma.creatorProfile.findFirst as jest.Mock).mockResolvedValue({
            id: 'key-1',
            circulatingSupply: 0,
            curveMilestones: null,
            baseExponent: 1,
            creatorRoyaltyBuyBps: 0,
         });
         (prisma.paymentAsset.findFirst as jest.Mock).mockResolvedValue(null);

         await expect(
            service.getBuyQuote({ keyId: 'key-1', quantity: 1, asset: 'NOPE' })
         ).rejects.toThrow(PaymentAssetNotFoundError);
      });
   });
});
