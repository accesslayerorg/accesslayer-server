// Integration test: creator list search no-results state
//
// Verifies that a search query returning zero creators produces a response
// with a searchTerm field in the pagination metadata, distinguishing it
// from the generic unfiltered empty state.

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

   it('includes searchTerm in meta when search returns zero results', async () => {
      const req = makeReq({ search: 'zzznomatch' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.meta).toHaveProperty('searchTerm', 'zzznomatch');
   });

   it('does not include searchTerm in meta for unfiltered empty list', async () => {
      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.meta).not.toHaveProperty('searchTerm');
   });

   it('does not include searchTerm when search is cleared (empty string)', async () => {
      const req = makeReq({ search: '' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.meta).not.toHaveProperty('searchTerm');
   });

   it('does not include searchTerm when search is whitespace-only', async () => {
      const req = makeReq({ search: '   ' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.meta).not.toHaveProperty('searchTerm');
   });

   it('does not include searchTerm when search returns results (non-zero total)', async () => {
      const now = new Date();
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         [
            {
               id: '1',
               userId: 'u1',
               handle: 'found1',
               displayName: 'Found One',
               isVerified: false,
               createdAt: now,
               updatedAt: now,
            } as any,
            {
               id: '2',
               userId: 'u2',
               handle: 'found2',
               displayName: 'Found Two',
               isVerified: true,
               createdAt: now,
               updatedAt: now,
            } as any,
         ],
         2,
      ]);

      const req = makeReq({ search: 'found' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.meta).not.toHaveProperty('searchTerm');
   });

   it('no-results search state is distinct from unfiltered empty state', async () => {
      const searchReq = makeReq({ search: 'zzznomatch' });
      const searchRes = makeRes();
      await httpListCreators(searchReq, searchRes, makeNext());
      const searchBody = searchRes.json.mock.calls[0][0];

      const emptyReq = makeReq();
      const emptyRes = makeRes();
      await httpListCreators(emptyReq, emptyRes, makeNext());
      const emptyBody = emptyRes.json.mock.calls[0][0];

      expect(searchBody.data.meta).toHaveProperty('searchTerm', 'zzznomatch');
      expect(emptyBody.data.meta).not.toHaveProperty('searchTerm');
   });
});
