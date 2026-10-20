import request from 'supertest';
import { createServer } from '../../utils/server.utils';
import { prisma } from '../../utils/prisma.utils';
import {
   getWhitelistStatus,
   creatorExists,
   getBulkWhitelistStatus,
   setOnChainWhitelistFetcher,
   buildWhitelistCacheKey,
   WHITELIST_CACHE_TTL_SECONDS,
} from './whitelist.service';
import * as cacheUtils from '../../utils/redis.utils';
import { processWhitelistEvents } from '../indexer/whitelist-indexer.service';

describe('Whitelist Endpoint Integration Tests (#1084)', () => {
   let app: any;
   const testCreatorId = 'key-test-creator-1084';
   const testCreatorHandle = 'test-creator-1084';
   const whitelistedWallet = 'GBTEST00000000000000000000000000000000000000000000000001';
   const nonWhitelistedWallet = 'GBTEST00000000000000000000000000000000000000000000000002';
   const thirdWallet = 'GBTEST00000000000000000000000000000000000000000000000003';

   let whitelistDb: Array<{ address: string; creatorId: string; createdAt: Date }>;
   const memoryCache = new Map<string, any>();

   beforeAll(async () => {
      app = await createServer();
   });

   beforeEach(() => {
      whitelistDb = [
         {
            address: whitelistedWallet,
            creatorId: testCreatorId,
            createdAt: new Date(),
         },
      ];
      memoryCache.clear();
      setOnChainWhitelistFetcher(null);

      // Mock prisma.creatorProfile
      (prisma.creatorProfile.findFirst as any).mockImplementation((args: any) => {
         const conditions = args?.where?.OR || [args?.where];
         const matches = conditions.some(
            (c: any) =>
               c?.id === testCreatorId ||
               c?.handle === testCreatorHandle ||
               c?.id === 'mock-id'
         );
         if (matches) {
            return Promise.resolve({
               id: testCreatorId,
               handle: testCreatorHandle,
               displayName: 'Test Creator',
               userId: 'user-1',
            });
         }
         return Promise.resolve(null);
      });

      (prisma.creatorProfile.findUnique as any).mockImplementation((args: any) => {
         if (args?.where?.id === testCreatorId || args?.where?.id === 'mock-id') {
            return Promise.resolve({
               id: testCreatorId,
               handle: testCreatorHandle,
               displayName: 'Test Creator',
               userId: 'user-1',
            });
         }
         return Promise.resolve(null);
      });

      // Mock prisma.registeredKey
      (prisma.registeredKey.findFirst as any).mockImplementation(() =>
         Promise.resolve(null)
      );

      // Mock prisma.whitelist
      (prisma.whitelist.findUnique as any).mockImplementation((args: any) => {
         const key = args?.where?.address_creatorId;
         if (!key) return Promise.resolve(null);
         const found = whitelistDb.find(
            w => w.creatorId === key.creatorId && w.address === key.address
         );
         return Promise.resolve(found ?? null);
      });

      (prisma.whitelist.findMany as any).mockImplementation((args: any) => {
         const creatorId = args?.where?.creatorId;
         const inList: string[] | undefined = args?.where?.address?.in;
         const matched = whitelistDb.filter(
            w =>
               w.creatorId === creatorId &&
               (!inList || inList.includes(w.address))
         );
         return Promise.resolve(matched);
      });

      (prisma.whitelist.count as any).mockImplementation((args: any) => {
         const creatorId = args?.where?.creatorId;
         const count = whitelistDb.filter(w => w.creatorId === creatorId).length;
         return Promise.resolve(count);
      });

      (prisma.whitelist.createMany as any).mockImplementation((args: any) => {
         let count = 0;
         for (const item of args?.data || []) {
            if (
               !whitelistDb.some(
                  w => w.creatorId === item.creatorId && w.address === item.address
               )
            ) {
               whitelistDb.push({ ...item, createdAt: new Date() });
               count++;
            }
         }
         return Promise.resolve({ count });
      });

      (prisma.whitelist.deleteMany as any).mockImplementation((args: any) => {
         const creatorId = args?.where?.creatorId;
         const addrs: string[] = args?.where?.address?.in ?? [
            args?.where?.address,
         ];
         const before = whitelistDb.length;
         whitelistDb = whitelistDb.filter(
            w => !(w.creatorId === creatorId && addrs.includes(w.address))
         );
         return Promise.resolve({ count: before - whitelistDb.length });
      });

      // Cache spies with in-memory backing
      jest.spyOn(cacheUtils, 'cacheGetJson').mockImplementation(async (key: string) => {
         return memoryCache.has(key) ? memoryCache.get(key) : null;
      });

      jest.spyOn(cacheUtils, 'cacheSetJson').mockImplementation(
         async (key: string, value: any) => {
            memoryCache.set(key, value);
         }
      );

      jest.spyOn(cacheUtils, 'cacheInvalidate').mockImplementation(
         async (...patterns: string[]) => {
            for (const pattern of patterns) {
               if (pattern.includes('*')) {
                  const prefix = pattern.replace('*', '');
                  for (const key of Array.from(memoryCache.keys())) {
                     if (key.startsWith(prefix)) {
                        memoryCache.delete(key);
                     }
                  }
               } else {
                  memoryCache.delete(pattern);
               }
            }
         }
      );
   });

   afterEach(() => {
      jest.restoreAllMocks();
   });

   describe('GET /keys/:key_id/whitelist/:wallet (#1084)', () => {
      it('AC1: returns 200 with is_whitelisted and whitelist_mode_enabled', async () => {
         const response = await request(app).get(
            `/keys/${testCreatorId}/whitelist/${whitelistedWallet}`
         );

         expect(response.status).toBe(200);
         expect(response.body.success).toBe(true);
         expect(response.body.data).toHaveProperty('is_whitelisted', true);
         expect(response.body.data).toHaveProperty('whitelist_mode_enabled', true);
         // Backward-compatible properties
         expect(response.body.data).toHaveProperty('isApproved', true);
         expect(response.body.data).toHaveProperty('whitelistEnabled', true);
      });

      it('AC2: returns is_whitelisted: false when wallet is not on the whitelist', async () => {
         const response = await request(app).get(
            `/keys/${testCreatorId}/whitelist/${nonWhitelistedWallet}`
         );

         expect(response.status).toBe(200);
         expect(response.body.data.is_whitelisted).toBe(false);
         expect(response.body.data.whitelist_mode_enabled).toBe(true);
      });

      it('AC4: returns whitelist_mode_enabled: false when key has no whitelist active', async () => {
         // Clear whitelist entries to simulate unrestricted key
         whitelistDb = [];

         const response = await request(app).get(
            `/keys/${testCreatorId}/whitelist/${whitelistedWallet}`
         );

         expect(response.status).toBe(200);
         expect(response.body.data.whitelist_mode_enabled).toBe(false);
         expect(response.body.data.is_whitelisted).toBe(false);
      });

      it('supports query-param format GET /keys/:keyId/whitelist?wallet=...', async () => {
         const response = await request(app)
            .get(`/keys/${testCreatorId}/whitelist`)
            .query({ wallet: whitelistedWallet });

         expect(response.status).toBe(200);
         expect(response.body.data.is_whitelisted).toBe(true);
         expect(response.body.data.whitelist_mode_enabled).toBe(true);
      });

      it('returns 404 for unknown key ID', async () => {
         const response = await request(app).get(
            `/keys/unknown-creator-key/whitelist/${whitelistedWallet}`
         );

         expect(response.status).toBe(404);
         expect(response.body.success).toBe(false);
      });

      it('rejects invalid wallet format with 400', async () => {
         const response = await request(app).get(
            `/keys/${testCreatorId}/whitelist/invalid-wallet-format-too-short`
         );

         // Validation error
         expect([400, 422]).toContain(response.status);
         expect(response.body.success).toBe(false);
      });

      it('rejects empty wallet parameter with 400', async () => {
         const response = await request(app)
            .get(`/keys/${testCreatorId}/whitelist`)
            .query({ wallet: '' });

         expect(response.status).toBe(400);
         expect(response.body.success).toBe(false);
      });
   });

   describe('POST /keys/:key_id/whitelist/check (#1084 Bulk Check)', () => {
      it('AC3: bulk check returns correct status for all submitted wallets', async () => {
         const response = await request(app)
            .post(`/keys/${testCreatorId}/whitelist/check`)
            .send({
               wallets: [whitelistedWallet, nonWhitelistedWallet, thirdWallet],
            });

         expect(response.status).toBe(200);
         expect(response.body.success).toBe(true);
         expect(response.body.data).toHaveProperty('whitelist_mode_enabled', true);
         expect(response.body.data).toHaveProperty('results');
         expect(response.body.data.results).toHaveLength(3);

         const r1 = response.body.data.results.find(
            (r: any) => r.wallet === whitelistedWallet
         );
         const r2 = response.body.data.results.find(
            (r: any) => r.wallet === nonWhitelistedWallet
         );
         const r3 = response.body.data.results.find(
            (r: any) => r.wallet === thirdWallet
         );

         expect(r1.is_whitelisted).toBe(true);
         expect(r1.whitelist_mode_enabled).toBe(true);
         expect(r2.is_whitelisted).toBe(false);
         expect(r2.whitelist_mode_enabled).toBe(true);
         expect(r3.is_whitelisted).toBe(false);
         expect(r3.whitelist_mode_enabled).toBe(true);
      });

      it('bulk check returns whitelist_mode_enabled: false for unrestricted keys', async () => {
         whitelistDb = [];

         const response = await request(app)
            .post(`/keys/${testCreatorId}/whitelist/check`)
            .send({
               wallets: [whitelistedWallet, nonWhitelistedWallet],
            });

         expect(response.status).toBe(200);
         expect(response.body.data.whitelist_mode_enabled).toBe(false);
         expect(response.body.data.results.every((r: any) => !r.is_whitelisted)).toBe(true);
      });

      it('returns 404 for unknown key in bulk check', async () => {
         const response = await request(app)
            .post('/keys/nonexistent-key-999/whitelist/check')
            .send({
               wallets: [whitelistedWallet],
            });

         expect(response.status).toBe(404);
      });

      it('validates request body in bulk check', async () => {
         // Empty wallets array
         const r1 = await request(app)
            .post(`/keys/${testCreatorId}/whitelist/check`)
            .send({ wallets: [] });
         expect(r1.status).toBe(400);

         // Missing wallets field
         const r2 = await request(app)
            .post(`/keys/${testCreatorId}/whitelist/check`)
            .send({});
         expect(r2.status).toBe(400);

         // Invalid wallet address format
         const r3 = await request(app)
            .post(`/keys/${testCreatorId}/whitelist/check`)
            .send({ wallets: ['not-a-valid-stellar-address'] });
         expect(r3.status).toBe(400);
      });
   });

   describe('On-chain get_whitelist_status Contract Call & Caching', () => {
      it('fetches status from contract simulation when on-chain fetcher is provided', async () => {
         setOnChainWhitelistFetcher(async (_keyId, wallet) => {
            if (wallet === whitelistedWallet) {
               return { is_whitelisted: true, whitelist_mode_enabled: true };
            }
            return { is_whitelisted: false, whitelist_mode_enabled: true };
         });

         const response = await request(app).get(
            `/keys/${testCreatorId}/whitelist/${whitelistedWallet}`
         );

         expect(response.status).toBe(200);
         expect(response.body.data.is_whitelisted).toBe(true);
         expect(response.body.data.whitelist_mode_enabled).toBe(true);
      });

      it('caches response with 30s TTL in Redis and serves from cache', async () => {
         const key = buildWhitelistCacheKey(testCreatorId, whitelistedWallet);

         // First call computes and sets cache
         await request(app).get(
            `/keys/${testCreatorId}/whitelist/${whitelistedWallet}`
         );
         expect(memoryCache.has(key)).toBe(true);
         expect(cacheUtils.cacheSetJson).toHaveBeenCalledWith(
            key,
            expect.objectContaining({ is_whitelisted: true }),
            WHITELIST_CACHE_TTL_SECONDS
         );

         // Modify DB behind cache to prove next call is served from cache
         whitelistDb = [];

         const cachedResponse = await request(app).get(
            `/keys/${testCreatorId}/whitelist/${whitelistedWallet}`
         );
         expect(cachedResponse.status).toBe(200);
         expect(cachedResponse.body.data.is_whitelisted).toBe(true);
      });

      it('AC5: cached response time is under 150ms', async () => {
         // Warm cache
         await request(app).get(
            `/keys/${testCreatorId}/whitelist/${whitelistedWallet}`
         );

         const start = Date.now();
         const res = await request(app).get(
            `/keys/${testCreatorId}/whitelist/${whitelistedWallet}`
         );
         const elapsed = Date.now() - start;

         expect(res.status).toBe(200);
         expect(elapsed).toBeLessThan(150);
      });
   });

   describe('Cache Invalidation on WalletWhitelisted and WalletRemovedFromWhitelist events', () => {
      it('AC2: invalidates cache for specific key/wallet pair on WalletWhitelisted', async () => {
         const key = buildWhitelistCacheKey(testCreatorId, nonWhitelistedWallet);
         // Seed cache with stale non-whitelisted status
         memoryCache.set(key, {
            is_whitelisted: false,
            whitelist_mode_enabled: true,
         });
         expect(memoryCache.has(key)).toBe(true);

         // Process WalletWhitelisted event
         await processWhitelistEvents([
            {
               eventType: 'WalletWhitelisted' as any,
               txHash: 'tx-whitelist-1',
               eventIndex: 0,
               ledger: 500,
               creatorId: testCreatorId,
               wallets: [nonWhitelistedWallet],
            },
         ]);

         // Specific cache entry must be invalidated
         expect(memoryCache.has(key)).toBe(false);
         // Database should now have the wallet
         expect(
            whitelistDb.some(
               w => w.creatorId === testCreatorId && w.address === nonWhitelistedWallet
            )
         ).toBe(true);

         // Querying the endpoint now reflects new whitelisted state
         const res = await request(app).get(
            `/keys/${testCreatorId}/whitelist/${nonWhitelistedWallet}`
         );
         expect(res.body.data.is_whitelisted).toBe(true);
      });

      it('AC2: invalidates cache for specific key/wallet pair on WalletRemovedFromWhitelist', async () => {
         const key = buildWhitelistCacheKey(testCreatorId, whitelistedWallet);
         // Seed cache with whitelisted status
         memoryCache.set(key, {
            is_whitelisted: true,
            whitelist_mode_enabled: true,
         });
         expect(memoryCache.has(key)).toBe(true);

         // Process WalletRemovedFromWhitelist event
         await processWhitelistEvents([
            {
               eventType: 'WalletRemovedFromWhitelist' as any,
               txHash: 'tx-whitelist-remove-1',
               eventIndex: 1,
               ledger: 501,
               creatorId: testCreatorId,
               wallets: [whitelistedWallet],
            },
         ]);

         // Specific cache entry must be invalidated
         expect(memoryCache.has(key)).toBe(false);
         // Database should no longer have the wallet
         expect(
            whitelistDb.some(
               w => w.creatorId === testCreatorId && w.address === whitelistedWallet
            )
         ).toBe(false);

         // Querying the endpoint now reflects unwhitelisted state
         const res = await request(app).get(
            `/keys/${testCreatorId}/whitelist/${whitelistedWallet}`
         );
         expect(res.body.data.is_whitelisted).toBe(false);
      });

      it('supports single wallet property in event', async () => {
         const key = buildWhitelistCacheKey(testCreatorId, thirdWallet);
         memoryCache.set(key, { is_whitelisted: false, whitelist_mode_enabled: true });

         await processWhitelistEvents([
            {
               eventType: 'WalletWhitelisted' as any,
               txHash: 'tx-single-wallet',
               eventIndex: 0,
               ledger: 502,
               creatorId: testCreatorId,
               wallet: thirdWallet,
            } as any,
         ]);

         expect(memoryCache.has(key)).toBe(false);
         expect(
            whitelistDb.some(
               w => w.creatorId === testCreatorId && w.address === thirdWallet
            )
         ).toBe(true);
      });
   });

   describe('Service Function Unit Tests', () => {
      it('getWhitelistStatus returns correct flags for whitelisted wallet', async () => {
         const status = await getWhitelistStatus(testCreatorId, whitelistedWallet);
         expect(status.is_whitelisted).toBe(true);
         expect(status.whitelist_mode_enabled).toBe(true);
         expect(status.isApproved).toBe(true);
         expect(status.whitelistEnabled).toBe(true);
      });

      it('getBulkWhitelistStatus returns bulk results object', async () => {
         const result = await getBulkWhitelistStatus(testCreatorId, [
            whitelistedWallet,
            nonWhitelistedWallet,
         ]);
         expect(result.total).toBe(2);
         expect(result.whitelist_mode_enabled).toBe(true);
         expect(result.results[0].wallet).toBe(whitelistedWallet);
         expect(result.results[0].is_whitelisted).toBe(true);
         expect(result.results[1].wallet).toBe(nonWhitelistedWallet);
         expect(result.results[1].is_whitelisted).toBe(false);
      });

      it('creatorExists correctly identifies existing and non-existing keys', async () => {
         expect(await creatorExists(testCreatorId)).toBe(true);
         expect(await creatorExists('unknown-creator-xyz')).toBe(false);
      });
   });
});
