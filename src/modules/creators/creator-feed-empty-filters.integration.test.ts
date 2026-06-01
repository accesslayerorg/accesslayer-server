// Integration test: creator feed empty filter combinations
//
// Verifies the complete response envelope and pagination metadata shape
// when various filter combinations are applied to an empty creator feed.
// Uses Jest mocks to keep fixtures minimal and deterministic — no database required.

import { httpListCreators } from './creators.controllers';
import * as creatorsUtils from './creators.utils';
import { logger } from '../../utils/logger.utils';
import { resolveCreatorListLimit } from './creators.limit.utils';
import { PUBLIC_OFFSET_PAGINATION_DEFAULTS } from '../../utils/public-list-query-defaults';

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

describe('GET /api/v1/creators — empty feed with filter combinations', () => {
   beforeEach(() => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([[], 0]);
   });

   afterEach(() => {
      jest.restoreAllMocks();
   });

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

   it('treats explicit defaults the same as omitted filter params', async () => {
      const omittedReq = makeReq();
      const omittedRes = makeRes();
      await httpListCreators(omittedReq, omittedRes, makeNext());

      const explicitDefaultsReq = makeReq({
         limit: String(resolveCreatorListLimit()),
         offset: String(PUBLIC_OFFSET_PAGINATION_DEFAULTS.offset),
         sort: 'createdAt',
         order: 'desc',
         search: '   ',
         include: '   ',
      });
      const explicitDefaultsRes = makeRes();
      await httpListCreators(explicitDefaultsReq, explicitDefaultsRes, makeNext());

      expect(creatorsUtils.fetchCreatorList).toHaveBeenNthCalledWith(
         1,
         expect.objectContaining({
            sort: 'createdAt',
            order: 'desc',
         })
      );
      expect(creatorsUtils.fetchCreatorList).toHaveBeenNthCalledWith(
         2,
         expect.objectContaining({
            limit: resolveCreatorListLimit(),
            offset: PUBLIC_OFFSET_PAGINATION_DEFAULTS.offset,
            sort: 'createdAt',
            order: 'desc',
         })
      );

      const explicitCallArgs = (creatorsUtils.fetchCreatorList as jest.Mock).mock
         .calls[1][0];

      expect(explicitCallArgs.search).toBeUndefined();
      expect(explicitCallArgs.include).toBeUndefined();

      expect(explicitDefaultsRes.json.mock.calls[0][0]).toEqual(
         omittedRes.json.mock.calls[0][0]
      );
   });

   it('handles empty query (no filters)', async () => {
      const req = makeReq({});
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const callArgs = (creatorsUtils.fetchCreatorList as jest.Mock).mock.calls[0][0];

      expect(callArgs).not.toHaveProperty('verified', true);
      expect(callArgs).not.toHaveProperty('verified', false);
      expect(callArgs).not.toHaveProperty('search');

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

   it('returns a valid empty response when search term matches no creators', async () => {
      const req = makeReq({ search: 'definitely-no-matching-creator' });
      const res = makeRes();

      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);

      expect(creatorsUtils.fetchCreatorList).toHaveBeenCalledWith(
         expect.objectContaining({
            search: 'definitely-no-matching-creator',
         })
      );

      const body = res.json.mock.calls[0][0];

      expect(body.success).toBe(true);
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('items');
      expect(body.data).toHaveProperty('meta');

      expect(Array.isArray(body.data.items)).toBe(true);
      expect(body.data.items).toEqual([]);

      expect(body.data.meta).toMatchObject({
         total: 0,
         hasMore: false,
      });
      expect(body.data.meta).toHaveProperty('limit');
      expect(body.data.meta).toHaveProperty('offset');
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

         jest.clearAllMocks();
         jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([[], 0]);
      }
   });

   it('coerces null items from fetchCreatorList to an empty array', async () => {
      jest
         .spyOn(creatorsUtils, 'fetchCreatorList')
         .mockResolvedValue([null as unknown as any[], 0]);

      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];

      expect(body.success).toBe(true);
      expect(Array.isArray(body.data.items)).toBe(true);
      expect(body.data.items).toHaveLength(0);
   });

   it('coerces undefined items from fetchCreatorList to an empty array', async () => {
      jest
         .spyOn(creatorsUtils, 'fetchCreatorList')
         .mockResolvedValue([undefined as unknown as any[], 0]);

      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];

      expect(body.success).toBe(true);
      expect(Array.isArray(body.data.items)).toBe(true);
      expect(body.data.items).toHaveLength(0);
   });

   it('items is always an array regardless of filter combination when data layer returns null', async () => {
      jest
         .spyOn(creatorsUtils, 'fetchCreatorList')
         .mockResolvedValue([null as unknown as any[], 0]);

      const filterCombinations: Array<Record<string, string>> = [
         { verified: 'true' },
         { search: 'artist' },
         { verified: 'false', search: 'test' },
         { limit: '5', offset: '10', verified: 'true' },
      ];

      for (const query of filterCombinations) {
         const req = makeReq(query);
         const res = makeRes();
         await httpListCreators(req, res, makeNext());

         const body = res.json.mock.calls[0][0];

         expect(Array.isArray(body.data.items)).toBe(true);
         expect(body.data.items).toHaveLength(0);

         jest.clearAllMocks();
         jest
            .spyOn(creatorsUtils, 'fetchCreatorList')
            .mockResolvedValue([null as unknown as any[], 0]);
      }
   });

   it('returns 400 for invalid limit parameter', async () => {
      const req = makeReq({ limit: 'invalid' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

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

describe('GET /api/v1/creators — unrecognized sort logging', () => {
   let warnSpy: jest.SpyInstance;

   beforeEach(() => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([[], 0]);
      warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
   });

   afterEach(() => {
      jest.restoreAllMocks();
   });

   it('logs unrecognized sort fields at warn level without changing the 400 response', async () => {
      const req = makeReq({ sort: 'invalidField' });
      req.requestId = 'req-invalid-sort';

      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(warnSpy).toHaveBeenCalledWith(
         expect.objectContaining({
            msg: 'Unrecognized creator list sort field',
            sort: 'invalidField',
            requestId: 'req-invalid-sort',
         })
      );
      expect(res.status).toHaveBeenCalledWith(400);
   });

   it('does not log for recognized sort fields', async () => {
      const req = makeReq({ sort: 'displayName' });
      req.requestId = 'req-valid-sort';

      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const sortWarnings = warnSpy.mock.calls.filter(
         ([payload]) => payload?.msg === 'Unrecognized creator list sort field'
      );

      expect(sortWarnings).toHaveLength(0);
   });
});