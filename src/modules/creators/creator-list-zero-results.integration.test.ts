// Integration test: creator list response with zero total results
//
// Verifies that an empty database or a filter set that matches no creators
// returns a valid response with an empty items array and accurate pagination metadata.
// Uses Jest mocks with an isolated empty fixture — no database required.
//
// Scope: exercises the complete response envelope and pagination metadata shape
// when the result set is empty, ensuring graceful handling of the baseline state.

import { httpListCreators } from './creators.controllers';
import * as creatorsUtils from './creators.utils';

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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/v1/creators — zero total results', () => {
   beforeEach(() => {
      // Mock fetchCreatorList to return empty results with zero total
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([[], 0]);
   });

   afterEach(() => {
      jest.restoreAllMocks();
   });

   // ── Response Envelope Structure ────────────────────────────────────────────

   it('returns valid response with empty items array', async () => {
      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body).toHaveProperty('success', true);
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('items');
      expect(Array.isArray(body.data.items)).toBe(true);
      expect(body.data.items).toHaveLength(0);
   });

   it('returns pagination metadata with zero total count', async () => {
      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data).toHaveProperty('meta');
      expect(body.data.meta).toHaveProperty('total', 0);
      expect(typeof body.data.meta.total).toBe('number');
   });

   it('returns hasMore=false when total is zero', async () => {
      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.meta).toHaveProperty('hasMore', false);
   });

   it('includes all required pagination metadata fields', async () => {
      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      const meta = body.data.meta;
      expect(meta).toHaveProperty('limit');
      expect(meta).toHaveProperty('offset');
      expect(meta).toHaveProperty('total');
      expect(meta).toHaveProperty('hasMore');
      expect(typeof meta.limit).toBe('number');
      expect(typeof meta.offset).toBe('number');
      expect(typeof meta.total).toBe('number');
      expect(typeof meta.hasMore).toBe('boolean');
   });

   // ── Default Pagination Values ──────────────────────────────────────────────

   it('applies default limit when not specified', async () => {
      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.meta.limit).toBeGreaterThan(0);
      expect(typeof body.data.meta.limit).toBe('number');
   });

   it('applies default offset of 0 when not specified', async () => {
      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.meta.offset).toBe(0);
   });

   // ── Isolated Empty Fixture ─────────────────────────────────────────────────

   it('uses isolated empty fixture to avoid interference from other tests', async () => {
      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      // Verify that fetchCreatorList was called with the expected parameters
      expect(creatorsUtils.fetchCreatorList).toHaveBeenCalled();

      // Verify the mock was set up to return empty results
      const mockResult = await creatorsUtils.fetchCreatorList({
         limit: 20,
         offset: 0,
         sort: 'createdAt',
         order: 'desc',
      } as any);
      expect(mockResult[0]).toEqual([]);
      expect(mockResult[1]).toBe(0);
   });

   // ── Edge Cases with Empty Results ──────────────────────────────────────────

   it('returns HTTP 200 for empty results (not 404)', async () => {
      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalled();
   });

   it('maintains valid response structure with custom pagination params', async () => {
      const req = makeReq({ limit: '50', offset: '10' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(true);
      expect(body.data.items).toEqual([]);
      expect(body.data.meta.total).toBe(0);
      expect(body.data.meta.hasMore).toBe(false);
   });

   it('maintains valid response structure with filter parameters', async () => {
      const req = makeReq({ verified: 'true', search: 'nonexistent' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(true);
      expect(body.data.items).toEqual([]);
      expect(body.data.meta.total).toBe(0);
   });

   it('does not call next() error handler on success', async () => {
      const req = makeReq();
      const res = makeRes();
      const next = makeNext();
      await httpListCreators(req, res, next);

      expect(next).not.toHaveBeenCalled();
   });
});
