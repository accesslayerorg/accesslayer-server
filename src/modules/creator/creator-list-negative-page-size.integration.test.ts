// Integration test: creator list endpoint — negative page size
//
// Verifies that:
//   1. A request with a negative page size returns HTTP 400
//   2. The error body matches the standard validation error shape
//   3. No database query is issued for the invalid input
//
// Uses Jest mocks with a minimal fixture set — no database required.
// Follows the same conventions as creator-list-page-size-boundary.integration.test.ts

import { httpListCreators } from '../creators/creators.controllers';
import * as creatorsUtils from '../creators/creators.utils';

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

describe('GET /api/v1/creators — negative page size', () => {
   afterEach(() => {
      jest.restoreAllMocks();
   });

   it('rejects limit=-1 with HTTP 400', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList');

      const req = makeReq({ limit: '-1' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(400);
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(false);
   });

   it('rejects limit=-10 with HTTP 400', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList');

      const req = makeReq({ limit: '-10' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(400);
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(false);
   });

   it('rejects limit=-100 with HTTP 400', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList');

      const req = makeReq({ limit: '-100' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(400);
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(false);
   });

   it('does not call fetchCreatorList when limit is negative', async () => {
      const spy = jest.spyOn(creatorsUtils, 'fetchCreatorList');

      const req = makeReq({ limit: '-5' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(spy).not.toHaveBeenCalled();
   });

   it('response body matches standard validation error shape', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList');

      const req = makeReq({ limit: '-1' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body).toHaveProperty('success', false);
      expect(body).toHaveProperty('message');
      expect(body).toHaveProperty('data');
      expect(Array.isArray(body.data)).toBe(true);
   });

   it('error details include the limit field', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList');

      const req = makeReq({ limit: '-1' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data[0]).toHaveProperty('field');
      expect(body.data[0].field).toBe('limit');
   });

   it('error message indicates invalid value', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList');

      const req = makeReq({ limit: '-1' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data[0]).toHaveProperty('message');
      expect(body.data[0].message).toBeDefined();
   });

   it('response does not include items array for negative limit', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList');

      const req = makeReq({ limit: '-1' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data?.items).toBeUndefined();
   });
});
