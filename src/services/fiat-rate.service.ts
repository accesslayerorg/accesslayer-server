// src/services/fiat-rate.service.ts
// XLM fiat rate proxy (#1219).
//
// The client needs XLM quotes in USD, EUR and NGN without calling a
// third-party price provider from the browser. This service fetches the
// quotes server-side and caches them in Redis:
//
// - Fresh snapshots live under `rates:xlm` with a 60 second TTL. A request
//   within that window is served entirely from cache.
// - The last successful snapshot is additionally kept under
//   `rates:xlm:stale` for 10 minutes so a short upstream outage can be
//   answered with `stale: true` instead of failing the request.
// - When the upstream fails and no usable snapshot exists, callers receive a
//   `FiatRateUpstreamError`, which the route maps to HTTP 503.

import { z } from 'zod';
import { cacheGetJson, cacheSetJson } from '../utils/redis.utils';
import { logger } from '../utils/logger.utils';

/** ISO codes the proxy supports. */
export const SUPPORTED_CURRENCIES = ['usd', 'eur', 'ngn'] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export function isSupportedCurrency(value: string): value is SupportedCurrency {
   return (SUPPORTED_CURRENCIES as readonly string[]).includes(value);
}

/** Asset every quote is expressed in. */
export const XLM_BASE_ASSET = 'XLM';

/** Fresh quote snapshot (60 second TTL). */
export const FIAT_RATES_CACHE_KEY = 'rates:xlm';

/** Last successful snapshot retained for the stale fallback window. */
export const FIAT_RATES_STALE_CACHE_KEY = 'rates:xlm:stale';

/** How long a snapshot is considered fresh. */
export const FIAT_RATES_CACHE_TTL_SECONDS = 60;

/** How long the last successful snapshot may be served as stale data. */
export const FIAT_RATES_STALE_TTL_SECONDS = 10 * 60;

/** Outbound request timeout for the upstream price provider. */
export const FIAT_RATES_UPSTREAM_TIMEOUT_MS = 5_000;

/**
 * Upstream price provider (CoinGecko simple price API, no API key required).
 * Only the server calls this URL; browsers talk to our own endpoint.
 */
export const FIAT_RATES_UPSTREAM_URL =
   'https://api.coingecko.com/api/v3/simple/price';

export type FiatRateMap = Partial<Record<SupportedCurrency, number>>;

export interface FiatRatesSnapshot {
   base: typeof XLM_BASE_ASSET;
   rates: FiatRateMap;
   fetchedAt: string;
}

export interface FiatRatesResponse extends FiatRatesSnapshot {
   /** True when the quote served is older than the 60 second fresh window. */
   stale: boolean;
}

/** Raised when upstream quotes cannot be fetched and no cached data exists. */
export class FiatRateUpstreamError extends Error {
   constructor(message: string) {
      super(message);
      this.name = 'FiatRateUpstreamError';
   }
}

export interface FiatRateServiceDependencies {
   fetchImpl?: typeof fetch;
   getCache?: <T>(key: string) => Promise<T | null>;
   setCache?: (
      key: string,
      value: unknown,
      ttlSeconds: number
   ) => Promise<void>;
   now?: () => number;
}

const upstreamResponseSchema = z.object({
   stellar: z.record(z.string(), z.number().finite()),
});

/** Builds the upstream request URL, always asking for every supported code. */
export function buildUpstreamUrl(): string {
   return `${FIAT_RATES_UPSTREAM_URL}?ids=stellar&vs_currencies=${SUPPORTED_CURRENCIES.join(
      ','
   )}`;
}

function errorMessage(error: unknown): string {
   return error instanceof Error ? error.message : String(error);
}

function normaliseCurrencies(
   currencies: readonly string[] | string
): SupportedCurrency[] {
   const values =
      typeof currencies === 'string' ? currencies.split(',') : currencies;
   const normalised = Array.from(
      new Set(
         values
            .map(currency => currency.trim().toLowerCase())
            .filter(currency => currency.length > 0)
      )
   );

   const supported = normalised.filter(isSupportedCurrency);
   return supported.length > 0 ? supported : [...SUPPORTED_CURRENCIES];
}

function pickRates(
   rates: FiatRateMap,
   currencies: readonly SupportedCurrency[]
): FiatRateMap {
   const picked: FiatRateMap = {};
   for (const currency of currencies) {
      const rate = rates[currency];
      if (typeof rate === 'number') {
         picked[currency] = rate;
      }
   }
   return picked;
}

/**
 * Fetches normalized XLM fiat quotes with Redis caching and stale fallback.
 *
 * Dependencies are injectable so tests can supply a fake clock, an in-memory
 * cache and a stubbed `fetch` without touching Redis or the network.
 */
export class FiatRateService {
   private readonly fetchImpl: typeof fetch;
   private readonly getCache: <T>(key: string) => Promise<T | null>;
   private readonly setCache: (
      key: string,
      value: unknown,
      ttlSeconds: number
   ) => Promise<void>;
   private readonly now: () => number;

   constructor(dependencies: FiatRateServiceDependencies = {}) {
      this.fetchImpl =
         dependencies.fetchImpl ??
         ((input, init) => globalThis.fetch(input, init));
      this.getCache = dependencies.getCache ?? cacheGetJson;
      this.setCache = dependencies.setCache ?? cacheSetJson;
      this.now = dependencies.now ?? Date.now;
   }

   /**
    * Returns quotes for the requested currencies.
    *
    * @param currencies ISO codes to return. Defaults to every supported code.
    * @throws {FiatRateUpstreamError} when upstream fails and no cached
    * snapshot within the 10 minute stale window is available.
    */
   async getRates(
      currencies: readonly string[] | string = [...SUPPORTED_CURRENCIES]
   ): Promise<FiatRatesResponse> {
      const requested = normaliseCurrencies(currencies);

      const fresh =
         await this.getCache<FiatRatesSnapshot>(FIAT_RATES_CACHE_KEY);
      if (this.isUsableSnapshot(fresh, requested)) {
         return this.toResponse(fresh, requested, false);
      }

      try {
         const snapshot = await this.fetchSnapshot();

         // Fire-and-forget is not used here: the write is fast and keeping the
         // cache warm is part of the request's contract.
         await Promise.all([
            this.setCache(
               FIAT_RATES_CACHE_KEY,
               snapshot,
               FIAT_RATES_CACHE_TTL_SECONDS
            ),
            this.setCache(
               FIAT_RATES_STALE_CACHE_KEY,
               snapshot,
               FIAT_RATES_STALE_TTL_SECONDS
            ),
         ]);

         return this.toResponse(snapshot, requested, false);
      } catch (error) {
         logger.warn(
            {
               type: 'fiat_rate_upstream_failure',
               error: errorMessage(error),
            },
            'Failed to fetch XLM fiat rates from upstream'
         );

         const stale = await this.getCache<FiatRatesSnapshot>(
            FIAT_RATES_STALE_CACHE_KEY
         );
         if (
            this.isUsableSnapshot(stale, requested) &&
            this.isWithinStaleWindow(stale)
         ) {
            return this.toResponse(stale, requested, true);
         }

         throw error instanceof FiatRateUpstreamError
            ? error
            : new FiatRateUpstreamError(
                 `Failed to fetch XLM fiat rates: ${errorMessage(error)}`
              );
      }
   }

   private toResponse(
      snapshot: FiatRatesSnapshot,
      currencies: readonly SupportedCurrency[],
      stale: boolean
   ): FiatRatesResponse {
      return {
         base: XLM_BASE_ASSET,
         rates: pickRates(snapshot.rates, currencies),
         fetchedAt: snapshot.fetchedAt,
         stale,
      };
   }

   private isUsableSnapshot(
      snapshot: FiatRatesSnapshot | null,
      currencies: readonly SupportedCurrency[]
   ): snapshot is FiatRatesSnapshot {
      if (
         !snapshot ||
         snapshot.base !== XLM_BASE_ASSET ||
         typeof snapshot.fetchedAt !== 'string' ||
         !snapshot.rates ||
         typeof snapshot.rates !== 'object'
      ) {
         return false;
      }

      return currencies.every(currency => {
         const rate = snapshot.rates[currency];
         return typeof rate === 'number' && Number.isFinite(rate);
      });
   }

   private isWithinStaleWindow(snapshot: FiatRatesSnapshot): boolean {
      const fetchedAtMs = Date.parse(snapshot.fetchedAt);
      if (!Number.isFinite(fetchedAtMs)) {
         return false;
      }
      return this.now() - fetchedAtMs <= FIAT_RATES_STALE_TTL_SECONDS * 1000;
   }

   private async fetchSnapshot(): Promise<FiatRatesSnapshot> {
      let response: Response;

      try {
         response = await this.fetchImpl(buildUpstreamUrl(), {
            method: 'GET',
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(FIAT_RATES_UPSTREAM_TIMEOUT_MS),
         });
      } catch (error) {
         throw new FiatRateUpstreamError(
            `Upstream rate provider request failed: ${errorMessage(error)}`
         );
      }

      if (!response.ok) {
         throw new FiatRateUpstreamError(
            `Upstream rate provider returned HTTP ${response.status}`
         );
      }

      let payload: unknown;
      try {
         payload = await response.json();
      } catch (error) {
         throw new FiatRateUpstreamError(
            `Upstream rate provider returned invalid JSON: ${errorMessage(
               error
            )}`
         );
      }

      const parsed = upstreamResponseSchema.safeParse(payload);
      if (!parsed.success) {
         throw new FiatRateUpstreamError(
            'Upstream rate provider returned an invalid payload'
         );
      }

      const rates: FiatRateMap = {};
      for (const currency of SUPPORTED_CURRENCIES) {
         const rate = parsed.data.stellar[currency];
         if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
            throw new FiatRateUpstreamError(
               `Upstream rate provider is missing a valid ${currency.toUpperCase()} rate`
            );
         }
         rates[currency] = rate;
      }

      return {
         base: XLM_BASE_ASSET,
         rates,
         fetchedAt: new Date(this.now()).toISOString(),
      };
   }
}

/** Shared instance used by the HTTP route. */
export const fiatRateService = new FiatRateService();

export default FiatRateService;
