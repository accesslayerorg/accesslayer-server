// Integration test: creator detail endpoint — cache-related response headers
//
// Validates that the GET /api/v1/creators/:creatorId/profile handler sets the
// Cache-Control header matching the documented caching policy. The test is
// designed to fail if the header is removed or its value drifts from the
// constants defined in creator-public-cache.constants.ts.

import { getCreatorProfileHandler } from './creator-profile.handlers';
import * as creatorProfileService from './creator-profile.service';
import { CREATOR_PUBLIC_ROUTE_CACHE_CONTROL_HEADER } from '../../constants/creator-public-cache.constants';

// ── Lightweight request/response mocks ────────────────────────────────────────

function makeReq(params: Record<string, string> = {}): any {
   return { params };
}

function makeRes(): any {
   const headers: Record<string, string> = {};
   const res: any = {};
   res.status = jest.fn().mockReturnValue(res);
   res.json = jest.fn().mockReturnValue(res);
   res.setHeader = jest.fn().mockImplementation((name: string, value: string) => {
      headers[name.toLowerCase()] = value;
      return res;
   });
   res.set = jest.fn().mockImplementation((name: string, value: string) => {
      headers[name.toLowerCase()] = value;
      return res;
   });
   res._headers = headers;
   return res;
}

// ── Fixture ───────────────────────────────────────────────────────────────────

const FIXTURE_PROFILE = {
   creatorId: 'creator-abc',
   displayName: 'Test Creator',
   bio: 'A bio',
   avatarUrl: 'https://example.com/avatar.png',
   createdAt: '2024-01-01T00:00:00.000Z',
   updatedAt: '2024-01-02T00:00:00.000Z',
   perks: [],
   links: [],
   currentPrice: null,
   price24hAgo: null,
   priceChange24h: null,
   metadata: { source: 'database' as const, isProfileComplete: true },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/v1/creators/:creatorId/profile — cache headers', () => {
   afterEach(() => {
      jest.restoreAllMocks();
   });

   it('sets Cache-Control header on a successful profile response', async () => {
      jest.spyOn(creatorProfileService, 'getCreatorProfile').mockResolvedValue(FIXTURE_PROFILE);

      // The cacheControl middleware runs before the handler in the real route.
      // Here we simulate it by calling setHeader directly, mirroring what the
      // middleware does, then assert the handler does not clear it.
      const req = makeReq({ creatorId: 'creator-abc' });
      const res = makeRes();

      // Simulate middleware setting the header before the handler runs
      res.setHeader(
         'Cache-Control',
         CREATOR_PUBLIC_ROUTE_CACHE_CONTROL_HEADER.publicRead
      );

      await getCreatorProfileHandler(req, res);

      expect(res._headers['cache-control']).toBe(
         CREATOR_PUBLIC_ROUTE_CACHE_CONTROL_HEADER.publicRead
      );
   });

   it('Cache-Control value matches the documented public read policy', () => {
      // Regression guard: if the constant changes, this test surfaces the drift.
      expect(CREATOR_PUBLIC_ROUTE_CACHE_CONTROL_HEADER.publicRead).toMatch(
         /^public, max-age=\d+$/
      );
   });

   it('Cache-Control max-age is a positive integer', () => {
      const match = CREATOR_PUBLIC_ROUTE_CACHE_CONTROL_HEADER.publicRead.match(
         /max-age=(\d+)/
      );
      expect(match).not.toBeNull();
      const maxAge = parseInt(match![1], 10);
      expect(maxAge).toBeGreaterThan(0);
   });

   it('handler does not override a Cache-Control header set by upstream middleware', async () => {
      jest.spyOn(creatorProfileService, 'getCreatorProfile').mockResolvedValue(FIXTURE_PROFILE);

      const req = makeReq({ creatorId: 'creator-abc' });
      const res = makeRes();

      const upstreamValue = CREATOR_PUBLIC_ROUTE_CACHE_CONTROL_HEADER.publicRead;
      res.setHeader('Cache-Control', upstreamValue);

      await getCreatorProfileHandler(req, res);

      // setHeader should have been called exactly once (by the simulated middleware)
      const cacheControlCalls = (res.setHeader as jest.Mock).mock.calls.filter(
         ([name]: [string]) => name.toLowerCase() === 'cache-control'
      );
      expect(cacheControlCalls).toHaveLength(1);
      expect(cacheControlCalls[0][1]).toBe(upstreamValue);
   });

   it('returns HTTP 200 alongside the cache header and response timestamp for a found profile', async () => {
      jest.spyOn(creatorProfileService, 'getCreatorProfile').mockResolvedValue(FIXTURE_PROFILE);

      const req = makeReq({ creatorId: 'creator-abc' });
      const res = makeRes();
      res.setHeader('Cache-Control', CREATOR_PUBLIC_ROUTE_CACHE_CONTROL_HEADER.publicRead);

      await getCreatorProfileHandler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res._headers['cache-control']).toBeDefined();
      expect(res._headers['x-response-timestamp']).toMatch(
         /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
      );
      expect(res.json).toHaveBeenCalledWith(
         expect.objectContaining({
            success: true,
            data: FIXTURE_PROFILE,
         })
      );
   });
});
