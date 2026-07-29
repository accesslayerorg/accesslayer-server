// Integration test: creator list search no-results state
//
// When a search query returns zero creators, the response should include the
// search term so that clients can display a no-results message that references
// the search term, distinct from the unfiltered empty state.
//
// Uses Jest mocks — no database connection required.

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

   it('includes searchTerm in response when search returns zero results', async () => {
      const req = makeReq({ search: 'zzznomatch' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      expect(body.data).toHaveProperty('searchTerm', 'zzznomatch');
   });

   it('does not include searchTerm when no search filter is applied', async () => {
      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data).not.toHaveProperty('searchTerm');
   });

   it('does not include searchTerm when search filter is whitespace-only', async () => {
      const req = makeReq({ search: '   ' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data).not.toHaveProperty('searchTerm');
   });

   it('does not include searchTerm when search filter is an empty string', async () => {
      const req = makeReq({ search: '' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data).not.toHaveProperty('searchTerm');
   });

   it('search no-results state is distinct from unfiltered empty state', async () => {
      const searchReq = makeReq({ search: 'zzznomatch' });
      const searchRes = makeRes();
      await httpListCreators(searchReq, searchRes, makeNext());

      const noFilterReq = makeReq();
      const noFilterRes = makeRes();
      await httpListCreators(noFilterReq, noFilterRes, makeNext());

      const searchBody = searchRes.json.mock.calls[0][0];
      const noFilterBody = noFilterRes.json.mock.calls[0][0];

      expect(searchBody.data).toHaveProperty('searchTerm');
      expect(noFilterBody.data).not.toHaveProperty('searchTerm');

      expect(searchBody.data.items).toEqual([]);
      expect(noFilterBody.data.items).toEqual([]);
      expect(searchBody.data.meta).toEqual(noFilterBody.data.meta);
   });
});