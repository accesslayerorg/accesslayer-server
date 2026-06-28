// Integration test: creator list response with partial database results
//
// Verifies that when the database returns fewer items than the requested page size
// (simulating a partial result set), the response is still valid and the
// pagination metadata accurately reflects the total count and the partial items.
//
// Scope: exercises the complete response envelope and pagination metadata shape
// when fewer results than the limit are returned due to a database limitation
// or partial failure.

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

describe('GET /api/v1/creators — partial database results', () => {
   beforeEach(() => {
      // Mock fetchCreatorList to return a partial result set.
      // E.g., limit requested is 20, but only 5 are returned, total is 50.
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         Array.from({ length: 5 }).map((_, i) => ({
            userId: `user-${i}`,
            handle: `handle-${i}`,
            displayName: `Name ${i}`,
         })) as any,
         50,
      ]);
   });

   afterEach(() => {
      jest.restoreAllMocks();
   });

   it('returns 200 and a valid items array', async () => {
      const req = makeReq({ limit: '20', offset: '0' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(true);
      expect(body.data.items).toHaveLength(5);
   });

   it('pagination metadata reflects the actual returned items count and total', async () => {
      const req = makeReq({ limit: '20', offset: '0' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      const meta = body.data.meta;
      
      expect(meta.limit).toBe(20);
      expect(meta.total).toBe(50);
      // hasMore = (offset + limit) < total => (0 + 20) < 50 => true
      expect(meta.hasMore).toBe(true);
   });
});
