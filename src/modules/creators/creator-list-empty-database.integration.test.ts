// Integration test: creator list returns empty array when no creators exist (#547)
//
// The creator list endpoint must return a 200 with an empty data array and
// accurate metadata when the database has no creator records — never a 404.
//
// Uses Jest mocks (isolated empty fixture) — no database connection required.

import { httpListCreators } from './creators.controllers';
import * as creatorsUtils from './creators.utils';

// ── Lightweight request / response mocks ──────────────────────────────────────

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

describe('GET /api/v1/creators — empty database (#547)', () => {
   beforeEach(() => {
      // Simulate an empty database: no creator records exist.
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([[], 0]);
   });

   afterEach(() => {
      jest.restoreAllMocks();
   });

   // Acceptance criterion: Returns 200 with empty data array
   it('returns HTTP 200 when no creators exist (not 404)', async () => {
      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
   });

   it('returns an empty data array when no creators exist', async () => {
      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('items');
      expect(Array.isArray(body.data.items)).toBe(true);
      expect(body.data.items).toHaveLength(0);
   });

   // Acceptance criterion: meta.total is 0
   it('returns meta.total of 0 when no creators exist', async () => {
      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data).toHaveProperty('meta');
      expect(body.data.meta).toHaveProperty('total', 0);
      expect(typeof body.data.meta.total).toBe('number');
   });

   // Acceptance criterion: meta.hasMore is false
   it('returns meta.hasMore of false when no creators exist', async () => {
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

      const meta = res.json.mock.calls[0][0].data.meta;
      expect(meta).toHaveProperty('limit');
      expect(meta).toHaveProperty('offset');
      expect(meta).toHaveProperty('total');
      expect(meta).toHaveProperty('hasMore');
      expect(typeof meta.limit).toBe('number');
      expect(typeof meta.offset).toBe('number');
      expect(typeof meta.hasMore).toBe('boolean');
   });

   it('applies default offset of 0 when not specified', async () => {
      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const meta = res.json.mock.calls[0][0].data.meta;
      expect(meta.offset).toBe(0);
   });

   it('still returns 200 with empty array for explicit pagination params', async () => {
      const req = makeReq({ limit: '50', offset: '100' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(res.status).toHaveBeenCalledWith(200);
      expect(body.data.items).toEqual([]);
      expect(body.data.meta.total).toBe(0);
      expect(body.data.meta.hasMore).toBe(false);
   });

   it('does not invoke the error handler (next) on a successful empty response', async () => {
      const req = makeReq();
      const res = makeRes();
      const next = makeNext();
      await httpListCreators(req, res, next);

      expect(next).not.toHaveBeenCalled();
   });
});
