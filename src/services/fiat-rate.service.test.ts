// src/services/fiat-rate.service.test.ts
import {
   FIAT_RATES_CACHE_KEY,
   FIAT_RATES_CACHE_TTL_SECONDS,
   FIAT_RATES_STALE_CACHE_KEY,
   FIAT_RATES_STALE_TTL_SECONDS,
   FiatRateService,
   FiatRateUpstreamError,
   type FiatRatesSnapshot,
} from './fiat-rate.service';

const NOW = Date.parse('2026-11-20T10:00:00.000Z');

const UPSTREAM_RATES = { usd: 0.42, eur: 0.39, ngn: 650.5 };

function upstreamResponse(
   body: unknown = { stellar: UPSTREAM_RATES },
   status = 200
): Response {
   return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
   } as unknown as Response;
}

function snapshot(
   fetchedAt: string,
   rates: FiatRatesSnapshot['rates'] = UPSTREAM_RATES
): FiatRatesSnapshot {
   return { base: 'XLM', rates: { ...rates }, fetchedAt };
}

function createCache(initial: Record<string, FiatRatesSnapshot> = {}) {
   const store = new Map<string, unknown>(Object.entries(initial));
   const getCache = async <T>(key: string): Promise<T | null> => {
      const value = store.get(key);
      return value === undefined ? null : (value as T);
   };
   const setCache = jest.fn(
      async (key: string, value: unknown): Promise<void> => {
         store.set(key, value);
      }
   );
   return { store, getCache, setCache };
}

function createService(
   overrides: {
      fetchImpl?: jest.Mock;
      cache?: ReturnType<typeof createCache>;
      now?: () => number;
   } = {}
) {
   const cache = overrides.cache ?? createCache();
   const fetchImpl =
      overrides.fetchImpl ?? jest.fn().mockResolvedValue(upstreamResponse());

   const service = new FiatRateService({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      getCache: cache.getCache,
      setCache: cache.setCache,
      now: overrides.now ?? (() => NOW),
   });

   return { service, fetchImpl, cache };
}

describe('FiatRateService', () => {
   describe('cache miss', () => {
      it('fetches upstream, returns every requested rate and caches the snapshot', async () => {
         const { service, fetchImpl, cache } = createService();

         const result = await service.getRates(['usd', 'eur', 'ngn']);

         expect(result).toEqual({
            base: 'XLM',
            rates: { usd: 0.42, eur: 0.39, ngn: 650.5 },
            fetchedAt: '2026-11-20T10:00:00.000Z',
            stale: false,
         });

         expect(fetchImpl).toHaveBeenCalledTimes(1);
         const requestedUrl = String(fetchImpl.mock.calls[0][0]);
         expect(requestedUrl).toContain('ids=stellar');
         expect(requestedUrl).toContain('vs_currencies=usd,eur,ngn');

         expect(cache.setCache).toHaveBeenCalledWith(
            FIAT_RATES_CACHE_KEY,
            expect.objectContaining({ base: 'XLM' }),
            FIAT_RATES_CACHE_TTL_SECONDS
         );
         expect(cache.setCache).toHaveBeenCalledWith(
            FIAT_RATES_STALE_CACHE_KEY,
            expect.objectContaining({ base: 'XLM' }),
            FIAT_RATES_STALE_TTL_SECONDS
         );
         expect(FIAT_RATES_CACHE_TTL_SECONDS).toBe(60);
         expect(FIAT_RATES_STALE_TTL_SECONDS).toBe(600);
      });

      it('only returns the currencies that were requested', async () => {
         const { service } = createService();

         const result = await service.getRates('usd');

         expect(result.rates).toEqual({ usd: 0.42 });
      });
   });

   describe('cache hit', () => {
      it('serves a preloaded snapshot without calling upstream', async () => {
         const cache = createCache({
            [FIAT_RATES_CACHE_KEY]: snapshot('2026-11-20T09:59:30.000Z'),
         });
         const { service, fetchImpl } = createService({ cache });

         const result = await service.getRates(['usd', 'eur']);

         expect(fetchImpl).not.toHaveBeenCalled();
         expect(result).toEqual({
            base: 'XLM',
            rates: { usd: 0.42, eur: 0.39 },
            fetchedAt: '2026-11-20T09:59:30.000Z',
            stale: false,
         });
         expect(cache.setCache).not.toHaveBeenCalled();
      });

      it('serves the second request within 60 seconds from cache', async () => {
         const { service, fetchImpl } = createService();

         const first = await service.getRates(['usd', 'eur', 'ngn']);
         const second = await service.getRates(['usd', 'eur', 'ngn']);

         expect(fetchImpl).toHaveBeenCalledTimes(1);
         expect(second).toEqual(first);
      });
   });

   describe('stale fallback', () => {
      it('serves the cached snapshot with stale: true when upstream fails', async () => {
         const cache = createCache({
            [FIAT_RATES_STALE_CACHE_KEY]: snapshot('2026-11-20T09:55:00.000Z'),
         });
         const fetchImpl = jest
            .fn()
            .mockRejectedValue(new Error('upstream connection reset'));
         const { service } = createService({ cache, fetchImpl });

         const result = await service.getRates(['usd', 'eur', 'ngn']);

         expect(result).toEqual({
            base: 'XLM',
            rates: { usd: 0.42, eur: 0.39, ngn: 650.5 },
            fetchedAt: '2026-11-20T09:55:00.000Z',
            stale: true,
         });
         expect(cache.setCache).not.toHaveBeenCalled();
      });

      it('serves stale data when upstream returns a non-2xx status', async () => {
         const cache = createCache({
            [FIAT_RATES_STALE_CACHE_KEY]: snapshot('2026-11-20T09:58:00.000Z'),
         });
         const fetchImpl = jest
            .fn()
            .mockResolvedValue(upstreamResponse({}, 502));
         const { service } = createService({ cache, fetchImpl });

         const result = await service.getRates(['usd']);

         expect(result.stale).toBe(true);
         expect(result.rates).toEqual({ usd: 0.42 });
      });

      it('does not serve a snapshot older than the 10 minute stale window', async () => {
         const cache = createCache({
            [FIAT_RATES_STALE_CACHE_KEY]: snapshot('2026-11-20T09:49:59.000Z'),
         });
         const fetchImpl = jest
            .fn()
            .mockRejectedValue(new Error('upstream timeout'));
         const { service } = createService({ cache, fetchImpl });

         await expect(service.getRates(['usd'])).rejects.toBeInstanceOf(
            FiatRateUpstreamError
         );
      });
   });

   describe('upstream failures', () => {
      it('throws when upstream fails and no cache exists', async () => {
         const fetchImpl = jest
            .fn()
            .mockRejectedValue(new Error('network unreachable'));
         const { service } = createService({ fetchImpl });

         await expect(service.getRates(['usd'])).rejects.toBeInstanceOf(
            FiatRateUpstreamError
         );
      });

      it('throws when upstream returns an invalid payload', async () => {
         const fetchImpl = jest
            .fn()
            .mockResolvedValue(upstreamResponse({ unexpected: true }));
         const { service, cache } = createService({ fetchImpl });

         await expect(service.getRates(['usd'])).rejects.toBeInstanceOf(
            FiatRateUpstreamError
         );
         expect(cache.setCache).not.toHaveBeenCalled();
      });

      it('throws when upstream omits a supported currency', async () => {
         const fetchImpl = jest
            .fn()
            .mockResolvedValue(
               upstreamResponse({ stellar: { usd: 0.42, eur: 0.39 } })
            );
         const { service } = createService({ fetchImpl });

         await expect(service.getRates(['usd'])).rejects.toBeInstanceOf(
            FiatRateUpstreamError
         );
      });
   });
});
