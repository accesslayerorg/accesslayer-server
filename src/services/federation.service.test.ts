// src/services/federation.service.test.ts

import { Keypair } from '@stellar/stellar-base';
import {
   FEDERATION_CACHE_TTL_SECONDS,
   FEDERATION_NEGATIVE_CACHE_TTL_SECONDS,
   FederationBlockedAddressError,
   FederationNotFoundError,
   FederationService,
   FederationTimeoutError,
   FederationUpstreamError,
   federationCacheKey,
   federationNegativeCacheKey,
   parseFederationAddress,
   type FederationResolution,
   type FederationServiceDependencies,
} from './federation.service';
import { isBlockedIpAddress } from '../utils/ssrf.utils';

const ACCOUNT_ID = Keypair.random().publicKey();
const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];

function createMemoryCache() {
   const values = new Map<string, unknown>();
   const ttls = new Map<string, number>();

   return {
      values,
      ttls,
      getCache: async <T>(key: string): Promise<T | null> =>
         (values.get(key) as T | undefined) ?? null,
      setCache: async (key: string, value: unknown, ttlSeconds: number) => {
         values.set(key, value);
         ttls.set(key, ttlSeconds);
      },
   };
}

function createService(overrides: Partial<FederationServiceDependencies> = {}) {
   const cache = createMemoryCache();
   const resolveFederation =
      (overrides.resolveFederation as jest.Mock | undefined) ??
      jest.fn().mockResolvedValue({ account_id: ACCOUNT_ID });
   const lookupHostname =
      (overrides.lookupHostname as jest.Mock | undefined) ??
      jest.fn(PUBLIC_LOOKUP);

   const service = new FederationService({
      ...overrides,
      resolveFederation,
      lookupHostname,
      getCache: cache.getCache,
      setCache: cache.setCache,
   });

   return { service, cache, resolveFederation, lookupHostname };
}

describe('parseFederationAddress', () => {
   it('normalizes a valid address', () => {
      expect(parseFederationAddress('Alice*Example.COM')).toEqual({
         name: 'alice',
         domain: 'example.com',
         address: 'alice*example.com',
      });
   });

   it.each([
      'alice',
      'alice*',
      '*example.com',
      'alice*example',
      'alice*bad_domain.com',
      'alice*-example.com',
      'alice*example..com',
      'alice*127.0.0.1',
      'alice*localhost',
      'ali ce*example.com',
      'a*b*c',
      'alice*example.c0m',
      'user@example.com',
   ])('rejects %s', address => {
      expect(parseFederationAddress(address)).toBeNull();
   });
});

describe('isBlockedIpAddress', () => {
   it.each([
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '255.255.255.255',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.5',
   ])('blocks %s', address => {
      expect(isBlockedIpAddress(address)).toBe(true);
   });

   it.each([
      '8.8.8.8',
      '93.184.216.34',
      '172.32.0.1',
      '2606:2800:220:1:248:1893:25c8:1946',
   ])('allows public address %s', address => {
      expect(isBlockedIpAddress(address)).toBe(false);
   });
});

describe('FederationService.resolve', () => {
   it('returns the resolved account, memo and memo type', async () => {
      const { service, resolveFederation } = createService({
         resolveFederation: jest.fn().mockResolvedValue({
            account_id: ACCOUNT_ID,
            memo: '12345',
            memo_type: 'id',
         }),
      });

      await expect(service.resolve('alice*example.com')).resolves.toEqual({
         accountId: ACCOUNT_ID,
         memo: '12345',
         memoType: 'id',
      });
      expect(resolveFederation).toHaveBeenCalledWith('alice*example.com');
   });

   it('caches successful resolutions for 10 minutes and skips the federation server on repeats', async () => {
      const { service, cache, resolveFederation, lookupHostname } =
         createService();

      const first = await service.resolve('alice*example.com');
      const second = await service.resolve('ALICE*Example.com');

      expect(second).toEqual(first);
      expect(resolveFederation).toHaveBeenCalledTimes(1);
      expect(lookupHostname).toHaveBeenCalledTimes(1);

      const key = federationCacheKey('alice*example.com');
      expect(cache.values.get(key)).toEqual({ accountId: ACCOUNT_ID });
      expect(cache.ttls.get(key)).toBe(FEDERATION_CACHE_TTL_SECONDS);
      expect(FEDERATION_CACHE_TTL_SECONDS).toBe(600);
   });

   it('caches not-found results for 1 minute and skips the federation server on repeats', async () => {
      const notFound = Object.assign(new Error('Federation record not found'), {
         name: 'NotFoundError',
      });
      const { service, cache, resolveFederation } = createService({
         resolveFederation: jest.fn().mockRejectedValue(notFound),
      });

      await expect(service.resolve('bob*example.com')).rejects.toBeInstanceOf(
         FederationNotFoundError
      );
      await expect(service.resolve('bob*example.com')).rejects.toBeInstanceOf(
         FederationNotFoundError
      );

      expect(resolveFederation).toHaveBeenCalledTimes(1);
      const key = federationNegativeCacheKey('bob*example.com');
      expect(cache.values.get(key)).toEqual({ notFound: true });
      expect(cache.ttls.get(key)).toBe(FEDERATION_NEGATIVE_CACHE_TTL_SECONDS);
      expect(FEDERATION_NEGATIVE_CACHE_TTL_SECONDS).toBe(60);
   });

   it.each([
      ['127.0.0.1', 4],
      ['10.0.0.7', 4],
      ['169.254.169.254', 4],
      ['::1', 6],
      ['fe80::1', 6],
   ])(
      'blocks lookups when the domain resolves to %s',
      async (address, family) => {
         const { service, resolveFederation } = createService({
            lookupHostname: jest.fn().mockResolvedValue([{ address, family }]),
         });

         await expect(
            service.resolve('alice*example.com')
         ).rejects.toBeInstanceOf(FederationBlockedAddressError);
         expect(resolveFederation).not.toHaveBeenCalled();
      }
   );

   it('blocks when any record among several points at internal space', async () => {
      const { service, resolveFederation } = createService({
         lookupHostname: jest.fn().mockResolvedValue([
            { address: '93.184.216.34', family: 4 },
            { address: '192.168.0.10', family: 4 },
         ]),
      });

      await expect(service.resolve('alice*example.com')).rejects.toBeInstanceOf(
         FederationBlockedAddressError
      );
      expect(resolveFederation).not.toHaveBeenCalled();
   });

   it('returns a not-found error when the domain has no DNS records', async () => {
      const { service, resolveFederation } = createService({
         lookupHostname: jest.fn().mockResolvedValue([]),
      });

      await expect(service.resolve('alice*example.com')).rejects.toBeInstanceOf(
         FederationNotFoundError
      );
      expect(resolveFederation).not.toHaveBeenCalled();
   });

   it('times out slow lookups', async () => {
      const { service } = createService({
         resolveFederation: jest.fn(() => new Promise<never>(() => undefined)),
         timeoutMs: 10,
      });

      await expect(service.resolve('alice*example.com')).rejects.toBeInstanceOf(
         FederationTimeoutError
      );
   });

   it('wraps unexpected federation server failures', async () => {
      const { service } = createService({
         resolveFederation: jest
            .fn()
            .mockRejectedValue(new Error('connection refused')),
      });

      await expect(service.resolve('alice*example.com')).rejects.toBeInstanceOf(
         FederationUpstreamError
      );
   });

   it('rejects records without a valid Stellar account id', async () => {
      const { service } = createService({
         resolveFederation: jest.fn().mockResolvedValue({
            account_id: 'not-an-account',
         }),
      });

      await expect(service.resolve('alice*example.com')).rejects.toBeInstanceOf(
         FederationUpstreamError
      );
   });

   it('validates the address before touching the network or cache', async () => {
      const { service, resolveFederation, lookupHostname } = createService();

      await expect(service.resolve('not-an-address')).rejects.toThrow(
         /Invalid federation address/
      );
      expect(lookupHostname).not.toHaveBeenCalled();
      expect(resolveFederation).not.toHaveBeenCalled();
   });

   it('serves a cached resolution without a DNS lookup', async () => {
      const cache = createMemoryCache();
      const cached: FederationResolution = { accountId: ACCOUNT_ID };
      await cache.setCache(
         federationCacheKey('alice*example.com'),
         cached,
         FEDERATION_CACHE_TTL_SECONDS
      );

      const lookupHostname = jest.fn(PUBLIC_LOOKUP);
      const resolveFederation = jest.fn();
      const service = new FederationService({
         lookupHostname,
         resolveFederation,
         getCache: cache.getCache,
         setCache: cache.setCache,
      });

      await expect(service.resolve('alice*example.com')).resolves.toEqual(
         cached
      );
      expect(lookupHostname).not.toHaveBeenCalled();
      expect(resolveFederation).not.toHaveBeenCalled();
   });
});
