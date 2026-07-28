// Integration test: search no-results state
//
// When a search query returns zero creators, the response meta includes the
// search term so the frontend can show a contextual no-results message instead
// of the generic empty state used for an unfiltered empty list.
//
// Acceptance criteria:
//  - No-results message visible when search returns zero results
//  - Message references or acknowledges the search term
//  - No-results state distinct from the unfiltered empty state
//  - Clearing search input removes the no-results state
//
// Uses Jest mocks (isolated empty fixture) — no database connection required.

import { httpListCreators } from './creators.controllers';
import * as creatorsUtils from './creators.utils';

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

describe('GET /api/v1/creators — search no-results state', () => {
   beforeEach(() => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([[], 0]);
   });

   afterEach(() => {
      jest.restoreAllMocks();
   });

   // ── No-results state with search ──────────────────────────────────────────

   it('includes search term in response meta when search returns zero results', async () => {
      const req = makeReq({ search: 'zzznomatch' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(true);
      expect(body.data.items).toEqual([]);
      expect(body.data.meta).toHaveProperty('search', 'zzznomatch');
   });

   it('returns HTTP 200 for search with no results', async () => {
      const req = makeReq({ search: 'zzznomatch' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
   });

   // ── Distinct from unfiltered empty state ──────────────────────────────────

   it('does not include search in meta for unfiltered empty list', async () => {
      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.items).toEqual([]);
      expect(body.data.meta).not.toHaveProperty('search');
   });

   it('no-results response with search differs from unfiltered empty response', async () => {
      const noSearchReq = makeReq({});
      const noSearchRes = makeRes();
      await httpListCreators(noSearchReq, noSearchRes, makeNext());
      const noSearchBody = noSearchRes.json.mock.calls[0][0];

      const searchReq = makeReq({ search: 'zzznomatch' });
      const searchRes = makeRes();
      await httpListCreators(searchReq, searchRes, makeNext());
      const searchBody = searchRes.json.mock.calls[0][0];

      // Both have empty items
      expect(noSearchBody.data.items).toEqual([]);
      expect(searchBody.data.items).toEqual([]);

      // But search response includes the search term in meta
      expect(noSearchBody.data.meta).not.toHaveProperty('search');
      expect(searchBody.data.meta).toHaveProperty('search', 'zzznomatch');
   });

   // ── Clearing search removes no-results state ──────────────────────────────

   it('omits search from meta when search param is empty string', async () => {
      const req = makeReq({ search: '' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.items).toEqual([]);
      expect(body.data.meta).not.toHaveProperty('search');
   });

   it('omits search from meta when search param is whitespace only', async () => {
      const req = makeReq({ search: '   ' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.items).toEqual([]);
      expect(body.data.meta).not.toHaveProperty('search');
   });

   // ── Additional assertions ─────────────────────────────────────────────────

   it('preserves all standard pagination meta fields alongside search', async () => {
      const req = makeReq({ search: 'zzznomatch' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const meta = res.json.mock.calls[0][0].data.meta;
      expect(meta).toHaveProperty('limit');
      expect(meta).toHaveProperty('offset');
      expect(meta).toHaveProperty('total', 0);
      expect(meta).toHaveProperty('hasMore', false);
      expect(meta).toHaveProperty('search', 'zzznomatch');
   });

   it('does not call next() error handler on search no-results', async () => {
      const req = makeReq({ search: 'zzznomatch' });
      const res = makeRes();
      const next = makeNext();
      await httpListCreators(req, res, next);

      expect(next).not.toHaveBeenCalled();
   });
});
