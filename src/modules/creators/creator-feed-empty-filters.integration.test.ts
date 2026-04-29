// Integration test: creator feed empty filter combinations
//
// Verifies the complete response envelope and pagination metadata shape
// when various filter combinations are applied to an empty creator feed.
// Uses Jest mocks to keep fixtures minimal and deterministic — no database required.

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
   return res;
}

function makeNext(): jest.Mock {
   return jest.fn();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/v1/creators — empty feed with filter combinations', () => {
   beforeEach(() => {
      // Mock fetchCreatorList to return empty results
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([[], 0]);
   });

   afterEach(() => {
      jest.restoreAllMocks();
   });

   // ── Response Envelope Structure ────────────────────────────────────────────

   it('returns stable response envelope with items array', async () => {
      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body).toHaveProperty('success', true);
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('items');
      expect(Array.isArray(body.data.items)).toBe(true);
      expect(body.data.items).toHaveLength(0);
   });

   it('returns stable response envelope with meta object', async () => {
      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data).toHaveProperty('meta');
      expect(typeof body.data.meta).toBe('object');
      expect(body.data.meta).toHaveProperty('limit');
      expect(body.data.meta).toHaveProperty('offset');
      expect(body.data.meta).toHaveProperty('total');
      expect(body.data.meta).toHaveProperty('hasMore');
   });

   it('responds with status 200 for empty results', async () => {
      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
   });

   // ── Default Values ──────────────────────────────────────────────────────────

   it('applies default limit when not specified', async () => {
      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(creatorsUtils.fetchCreatorList).toHaveBeenCalledWith(
         expect.objectContaining({
            limit: expect.any(Number),
         })
      );

      const body = res.json.mock.calls[0][0];
      expect(typeof body.data.meta.limit).toBe('number');
      expect(body.data.meta.limit).toBeGreaterThan(0);
   });

   it('applies default offset of 0 when not specified', async () => {
      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(creatorsUtils.fetchCreatorList).toHaveBeenCalledWith(
         expect.objectContaining({
            offset: 0,
         })
      );

      const body = res.json.mock.calls[0][0];
      expect(body.data.meta.offset).toBe(0);
   });

   it('applies default sort when not specified', async () => {
      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(creatorsUtils.fetchCreatorList).toHaveBeenCalledWith(
         expect.objectContaining({
            sort: expect.any(String),
            order: expect.any(String),
         })
      );
   });

   // ── Empty Filter Combinations ───────────────────────────────────────────────

   it('handles empty query (no filters)', async () => {
      const req = makeReq({});
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(creatorsUtils.fetchCreatorList).toHaveBeenCalledWith(
         expect.objectContaining({
            verified: undefined,
            search: undefined,
         })
      );

      const body = res.json.mock.calls[0][0];
      expect(body.data.items).toHaveLength(0);
      expect(body.data.meta.total).toBe(0);
      expect(body.data.meta.hasMore).toBe(false);
   });

   it('handles verified=true filter with empty results', async () => {
      const req = makeReq({ verified: 'true' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(creatorsUtils.fetchCreatorList).toHaveBeenCalledWith(
         expect.objectContaining({
            verified: true,
         })
      );

      const body = res.json.mock.calls[0][0];
      expect(body.data.items).toHaveLength(0);
      expect(body.data.meta.total).toBe(0);
   });

   it('handles verified=false filter with empty results', async () => {
      const req = makeReq({ verified: 'false' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(creatorsUtils.fetchCreatorList).toHaveBeenCalledWith(
         expect.objectContaining({
            verified: false,
         })
      );

      const body = res.json.mock.calls[0][0];
      expect(body.data.items).toHaveLength(0);
      expect(body.data.meta.total).toBe(0);
   });

   it('handles search filter with empty results', async () => {
      const req = makeReq({ search: 'nonexistent' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(creatorsUtils.fetchCreatorList).toHaveBeenCalledWith(
         expect.objectContaining({
            search: 'nonexistent',
         })
      );

      const body = res.json.mock.calls[0][0];
      expect(body.data.items).toHaveLength(0);
      expect(body.data.meta.total).toBe(0);
   });

   it('handles whitespace-only search (normalized to undefined)', async () => {
      const req = makeReq({ search: '   ' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(creatorsUtils.fetchCreatorList).toHaveBeenCalledWith(
         expect.objectContaining({
            search: undefined,
         })
      );

      const body = res.json.mock.calls[0][0];
      expect(body.data.items).toHaveLength(0);
   });

   it('handles empty string search (normalized to undefined)', async () => {
      const req = makeReq({ search: '' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(creatorsUtils.fetchCreatorList).toHaveBeenCalledWith(
         expect.objectContaining({
            search: undefined,
         })
      );

      const body = res.json.mock.calls[0][0];
      expect(body.data.items).toHaveLength(0);
   });

   it('handles combined verified + search filters with empty results', async () => {
      const req = makeReq({ verified: 'true', search: 'alice' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(creatorsUtils.fetchCreatorList).toHaveBeenCalledWith(
         expect.objectContaining({
            verified: true,
            search: 'alice',
         })
      );

      const body = res.json.mock.calls[0][0];
      expect(body.data.items).toHaveLength(0);
      expect(body.data.meta.total).toBe(0);
   });

   // ── Pagination Metadata Consistency ─────────────────────────────────────────

   it('meta.total is 0 for empty results', async () => {
      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.meta.total).toBe(0);
   });

   it('meta.hasMore is false for empty results', async () => {
      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.meta.hasMore).toBe(false);
   });

   it('meta.offset reflects requested offset even when empty', async () => {
      const req = makeReq({ offset: '20' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.meta.offset).toBe(20);
   });

   it('meta.limit reflects requested limit even when empty', async () => {
      const req = makeReq({ limit: '10' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.meta.limit).toBe(10);
   });

   // ── Sort and Order Parameters ───────────────────────────────────────────────

   it('handles sort parameter with empty results', async () => {
      const req = makeReq({ sort: 'displayName' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(creatorsUtils.fetchCreatorList).toHaveBeenCalledWith(
         expect.objectContaining({
            sort: 'displayName',
         })
      );

      const body = res.json.mock.calls[0][0];
      expect(body.data.items).toHaveLength(0);
   });

   it('handles order parameter with empty results', async () => {
      const req = makeReq({ order: 'asc' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(creatorsUtils.fetchCreatorList).toHaveBeenCalledWith(
         expect.objectContaining({
            order: 'asc',
         })
      );

      const body = res.json.mock.calls[0][0];
      expect(body.data.items).toHaveLength(0);
   });

   it('handles combined sort + order with empty results', async () => {
      const req = makeReq({ sort: 'createdAt', order: 'desc' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(creatorsUtils.fetchCreatorList).toHaveBeenCalledWith(
         expect.objectContaining({
            sort: 'createdAt',
            order: 'desc',
         })
      );

      const body = res.json.mock.calls[0][0];
      expect(body.data.items).toHaveLength(0);
   });

   // ── Complex Filter Combinations ─────────────────────────────────────────────

   it('handles all filters combined with empty results', async () => {
      const req = makeReq({
         limit: '15',
         offset: '30',
         sort: 'displayName',
         order: 'asc',
         verified: 'true',
         search: 'test',
      });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(creatorsUtils.fetchCreatorList).toHaveBeenCalledWith(
         expect.objectContaining({
            limit: 15,
            offset: 30,
            sort: 'displayName',
            order: 'asc',
            verified: true,
            search: 'test',
         })
      );

      const body = res.json.mock.calls[0][0];
      expect(body.data.items).toHaveLength(0);
      expect(body.data.meta).toMatchObject({
         limit: 15,
         offset: 30,
         total: 0,
         hasMore: false,
      });
   });

   // ── Response Envelope Stability ─────────────────────────────────────────────

   it('maintains consistent envelope shape across different filter combinations', async () => {
      const testCases: Array<Record<string, string>> = [
         {},
         { verified: 'true' },
         { search: 'test' },
         { verified: 'false', search: 'alice' },
         { limit: '5', offset: '10' },
      ];

      for (const query of testCases) {
         const req = makeReq(query);
         const res = makeRes();
         await httpListCreators(req, res, makeNext());

         const body = res.json.mock.calls[0][0];
         
         // Verify consistent structure
         expect(body).toHaveProperty('success', true);
         expect(body).toHaveProperty('data');
         expect(body.data).toHaveProperty('items');
         expect(body.data).toHaveProperty('meta');
         expect(Array.isArray(body.data.items)).toBe(true);
         expect(body.data.items).toHaveLength(0);
         expect(body.data.meta).toHaveProperty('limit');
         expect(body.data.meta).toHaveProperty('offset');
         expect(body.data.meta).toHaveProperty('total', 0);
         expect(body.data.meta).toHaveProperty('hasMore', false);

         // Reset mocks for next iteration
         jest.clearAllMocks();
         jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([[], 0]);
      }
   });

   // ── Validation Error Handling ───────────────────────────────────────────────

   it('returns 400 for invalid limit parameter', async () => {
      const req = makeReq({ limit: 'invalid' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      // Should call sendValidationError which sets status 400
      expect(res.status).toHaveBeenCalledWith(400);
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(false);
   });

   it('returns 400 for invalid offset parameter', async () => {
      const req = makeReq({ offset: 'invalid' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(400);
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(false);
   });

   it('returns 400 for invalid sort parameter', async () => {
      const req = makeReq({ sort: 'invalidField' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(400);
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(false);
   });

   it('returns 400 for invalid order parameter', async () => {
      const req = makeReq({ order: 'invalid' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(400);
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(false);
   });
});
