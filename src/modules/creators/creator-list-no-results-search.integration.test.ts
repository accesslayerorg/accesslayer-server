// Integration test: creator list no-results state for an unmatched search term
//
// Verifies that when a search query returns zero creators the list response
// exposes a distinct `noResults` state with a message that references the
// search term, and that this state is separate from the unfiltered empty
// state (which uses `state: 'empty'` and no message). Uses Jest mocks so no
// database is required.

import { httpListCreators } from './creators.controllers';
import * as creatorsUtils from './creators.utils';

// ── Lightweight request/response mocks ────────────────────────────────────────

const SEARCH_TERM = 'zzznomatch';

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

function getBody(res: any) {
   return res.json.mock.calls[0][0];
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/v1/creators — no-results state for unmatched search', () => {
   beforeEach(() => {
      // Mock the creator search to return zero results for every query.
      jest
         .spyOn(creatorsUtils, 'fetchCreatorList')
         .mockResolvedValue([[], 0]);
   });

   afterEach(() => {
      jest.restoreAllMocks();
   });

   it('returns a no-results message that references the search term', async () => {
      const req = makeReq({ search: SEARCH_TERM });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
      const body = getBody(res);
      expect(body.data.state).toBe('noResults');
      expect(body.data.message).toEqual(
         expect.stringContaining(SEARCH_TERM)
      );
   });

   it('keeps the no-results state distinct from the unfiltered empty state', async () => {
      const searchRes = makeRes();
      await httpListCreators(makeReq({ search: SEARCH_TERM }), searchRes, makeNext());
      const noResultsBody = getBody(searchRes);

      const emptyRes = makeRes();
      await httpListCreators(makeReq(), emptyRes, makeNext());
      const emptyBody = getBody(emptyRes);

      // Search with zero matches → noResults + message
      expect(noResultsBody.data.state).toBe('noResults');
      expect(noResultsBody.data.message).toBeDefined();

      // Unfiltered empty list → empty, no message
      expect(emptyBody.data.state).toBe('empty');
      expect(emptyBody.data.message).toBeUndefined();

      // The two states must differ
      expect(noResultsBody.data.state).not.toBe(emptyBody.data.state);
   });

   it('removes the no-results state when the search input is cleared', async () => {
      const searchRes = makeRes();
      await httpListCreators(makeReq({ search: SEARCH_TERM }), searchRes, makeNext());
      expect(getBody(searchRes).data.state).toBe('noResults');

      // Clearing the search returns the unfiltered empty state
      const clearedRes = makeRes();
      await httpListCreators(makeReq(), clearedRes, makeNext());
      const clearedBody = getBody(clearedRes);

      expect(clearedBody.data.state).toBe('empty');
      expect(clearedBody.data.message).toBeUndefined();
   });

   it('still reports zero total creators for the no-results search', async () => {
      const req = makeReq({ search: SEARCH_TERM });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = getBody(res);
      expect(body.data.items).toEqual([]);
      expect(body.data.meta.total).toBe(0);
      expect(body.data.meta.hasMore).toBe(false);
   });
});
