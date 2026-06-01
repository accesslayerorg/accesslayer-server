// Integration test: creator stats endpoint — no trade history
//
// Verifies that:
//   1. A creator with no trade history returns a valid response
//   2. Supply and holder count fields are zero rather than null or absent
//   3. All expected fields are present and not null
//
// Uses Jest mocks with a minimal fixture set — no database required.
// Follows the same conventions as creator-detail-empty-social-links.integration.test.ts

import { httpGetCreatorStats } from '../creators/creators.controllers';

// ── Lightweight request/response mocks ────────────────────────────────────────

function makeReq(params: Record<string, string> = {}): any {
   return { params };
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

describe('GET /api/v1/creators/:id/stats — no trade history', () => {
   afterEach(() => {
      jest.restoreAllMocks();
   });

   it('returns HTTP 200 for a creator with no trade history', async () => {
      const req = makeReq({ id: 'creator-1' });
      const res = makeRes();
      await httpGetCreatorStats(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
   });

   it('response includes holderCount field set to zero', async () => {
      const req = makeReq({ id: 'creator-1' });
      const res = makeRes();
      await httpGetCreatorStats(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data).toHaveProperty('holderCount');
      expect(body.data.holderCount).toBe(0);
   });

   it('response includes totalSupply field set to zero', async () => {
      const req = makeReq({ id: 'creator-1' });
      const res = makeRes();
      await httpGetCreatorStats(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data).toHaveProperty('totalSupply');
      expect(body.data.totalSupply).toBe(0);
   });

   it('response includes totalVolume field set to zero', async () => {
      const req = makeReq({ id: 'creator-1' });
      const res = makeRes();
      await httpGetCreatorStats(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data).toHaveProperty('totalVolume');
      expect(body.data.totalVolume).toBe(0);
   });

   it('holderCount is not null or absent', async () => {
      const req = makeReq({ id: 'creator-1' });
      const res = makeRes();
      await httpGetCreatorStats(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.holderCount).not.toBeNull();
      expect(body.data.holderCount).toBeDefined();
   });

   it('totalSupply is not null or absent', async () => {
      const req = makeReq({ id: 'creator-1' });
      const res = makeRes();
      await httpGetCreatorStats(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.totalSupply).not.toBeNull();
      expect(body.data.totalSupply).toBeDefined();
   });

   it('response envelope is well-formed with success field', async () => {
      const req = makeReq({ id: 'creator-1' });
      const res = makeRes();
      await httpGetCreatorStats(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body).toHaveProperty('success', true);
      expect(body).toHaveProperty('data');
   });

   it('all expected numeric fields are present in response', async () => {
      const req = makeReq({ id: 'creator-1' });
      const res = makeRes();
      await httpGetCreatorStats(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      const expectedFields = ['holderCount', 'totalSupply', 'totalVolume'];
      expectedFields.forEach(field => {
         expect(body.data).toHaveProperty(field);
         expect(typeof body.data[field]).toBe('number');
      });
   });
});
