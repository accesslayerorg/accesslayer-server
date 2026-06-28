// Integration test: creator list endpoint — maximum page size boundary
//
// Verifies that:
//   1. A request at exactly MAX_PAGE_SIZE is accepted and returns a well-formed
//      response with no more than MAX_PAGE_SIZE items.
//   2. A request above MAX_PAGE_SIZE is rejected with HTTP 400 before the
//      service layer is reached.
//
// Uses Jest mocks with a minimal fixture set — no database required.
// Follows the same conventions as creator-feed-empty-filters.integration.test.ts
// and creator-feed-multi-filter.integration.test.ts.

import { httpListCreators } from './creators.controllers';
import * as creatorsUtils from './creators.utils';
import type { CreatorProfile } from '../../types/profile.types';
import {
   MAX_PAGE_SIZE,
   MIN_PAGE_SIZE,
} from '../../constants/pagination.constants';

// ── Lightweight request/response mocks ────────────────────────────────────────

function makeReq(query: Record<string, string> = {}): any {
   return { query };
}

function makeRes(): any {
   const res: any = {};
   res.status = jest.fn().mockReturnValue(res);
   res.json = jest.fn().mockReturnValue(res);
   res.setHeader = jest.fn().mockReturnValue(res);
   res.set = jest.fn().mockReturnValue(res);
   return res;
}

function makeNext(): jest.Mock {
   return jest.fn();
}

// ── Minimal fixture factory ───────────────────────────────────────────────────
//
// Builds `count` distinct CreatorProfile stubs — enough for the mock to return
// a plausible MAX_PAGE_SIZE-length list without enumerating 100 hand-crafted objects.

function makeFixtures(count: number): CreatorProfile[] {
   return Array.from({ length: count }, (_, i) => ({
      id: `cuid-${i + 1}`,
      userId: `user-${i + 1}`,
      handle: `creator_${i + 1}`,
      displayName: `Creator ${i + 1}`,
      isVerified: false,
      createdAt: new Date('2024-01-01'),
      updatedAt: new Date('2024-01-01'),
   }));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/v1/creators — page size boundary', () => {
   afterEach(() => {
      jest.restoreAllMocks();
   });

   // ── Exactly at MAX_PAGE_SIZE ───────────────────────────────────────────────

   it('accepts limit equal to MAX_PAGE_SIZE and returns HTTP 200', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         makeFixtures(MAX_PAGE_SIZE),
         MAX_PAGE_SIZE,
      ]);

      const req = makeReq({ limit: String(MAX_PAGE_SIZE) });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(true);
   });

   it('passes limit=MAX_PAGE_SIZE to fetchCreatorList unmodified', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([[], 0]);

      const req = makeReq({ limit: String(MAX_PAGE_SIZE) });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(creatorsUtils.fetchCreatorList).toHaveBeenCalledWith(
         expect.objectContaining({ limit: MAX_PAGE_SIZE })
      );
   });

   it('response contains no more than MAX_PAGE_SIZE items when limit=MAX_PAGE_SIZE', async () => {
      const fixtures = makeFixtures(MAX_PAGE_SIZE);
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         fixtures,
         MAX_PAGE_SIZE,
      ]);

      const req = makeReq({ limit: String(MAX_PAGE_SIZE) });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.items.length).toBeLessThanOrEqual(MAX_PAGE_SIZE);
   });

   it('pagination meta reflects limit=MAX_PAGE_SIZE in the response', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         makeFixtures(MAX_PAGE_SIZE),
         MAX_PAGE_SIZE,
      ]);

      const req = makeReq({ limit: String(MAX_PAGE_SIZE) });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.meta.limit).toBe(MAX_PAGE_SIZE);
      expect(body.data.meta.total).toBe(MAX_PAGE_SIZE);
      expect(body.data.meta.hasMore).toBe(false);
   });

   it('response envelope is well-formed at the limit boundary', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         makeFixtures(3),
         3,
      ]);

      const req = makeReq({ limit: String(MAX_PAGE_SIZE) });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body).toHaveProperty('success', true);
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('items');
      expect(body.data).toHaveProperty('meta');
      expect(Array.isArray(body.data.items)).toBe(true);
      expect(body.data.meta).toMatchObject({
         limit: MAX_PAGE_SIZE,
         offset: expect.any(Number),
         total: expect.any(Number),
         hasMore: expect.any(Boolean),
      });
   });

   // ── One above MAX_PAGE_SIZE ────────────────────────────────────────────────

   it('rejects limit one above MAX_PAGE_SIZE with HTTP 400', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList');

      const req = makeReq({ limit: String(MAX_PAGE_SIZE + 1) });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(400);
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(false);
   });

   it('does not call fetchCreatorList when limit exceeds MAX_PAGE_SIZE', async () => {
      const spy = jest.spyOn(creatorsUtils, 'fetchCreatorList');

      const req = makeReq({ limit: String(MAX_PAGE_SIZE + 1) });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(spy).not.toHaveBeenCalled();
   });

   it('response body is not a success envelope when limit exceeds MAX_PAGE_SIZE', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList');

      const req = makeReq({ limit: String(MAX_PAGE_SIZE + 1) });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(false);
      // The data field should be absent or not carry a valid items array
      expect(body.data?.items).toBeUndefined();
   });

   // ── Well-above MAX_PAGE_SIZE (sanity check) ───────────────────────────────

   it('rejects a very large limit (e.g. 9999) with HTTP 400', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList');

      const req = makeReq({ limit: '9999' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(400);
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(false);
   });

   // ── Adjacent boundary below MAX_PAGE_SIZE ────────────────────────────────

   it('accepts limit one below MAX_PAGE_SIZE (MAX_PAGE_SIZE - 1) with HTTP 200', async () => {
      const belowMax = MAX_PAGE_SIZE - 1;
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         makeFixtures(belowMax),
         belowMax,
      ]);

      const req = makeReq({ limit: String(belowMax) });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(true);
      expect(body.data.meta.limit).toBe(belowMax);
   });

   // ── MIN_PAGE_SIZE boundary ────────────────────────────────────────────────

   it('accepts limit equal to MIN_PAGE_SIZE with HTTP 200', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         makeFixtures(1),
         1,
      ]);

      const req = makeReq({ limit: String(MIN_PAGE_SIZE) });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body.data.meta.limit).toBe(MIN_PAGE_SIZE);
   });
});
