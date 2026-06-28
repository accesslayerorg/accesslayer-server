// Integration test: creator list total count accuracy after filter
//
// Verifies that when a category filter is applied, the total count field
// in the pagination metadata correctly reflects the number of matching creators,
// rather than the total unfiltered count.
// Uses Jest mocks to keep the tests deterministic without requiring database connection.

import { httpListCreators } from './creators.controllers';
import * as creatorsUtils from './creators.utils';
import { CreatorProfile } from '../../types/profile.types';

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
   return jest.fn((err) => {
      if (err) {
         console.error('NEXT CALLED WITH ERROR:', err);
      }
   });
}

// ── Mock Fixture Data with known split ────────────────────────────────────────

const mockMatchingCreators = [
   { id: '1', displayName: 'Gamer One', handle: 'gamer1', category: 'gaming', avatarUrl: 'http://avatar1.png', isVerified: true, createdAt: new Date(), updatedAt: new Date() },
   { id: '2', displayName: 'Gamer Two', handle: 'gamer2', category: 'gaming', avatarUrl: 'http://avatar2.png', isVerified: true, createdAt: new Date(), updatedAt: new Date() },
   { id: '3', displayName: 'Gamer Three', handle: 'gamer3', category: 'gaming', avatarUrl: 'http://avatar3.png', isVerified: true, createdAt: new Date(), updatedAt: new Date() },
] as unknown as CreatorProfile[];

const mockNonMatchingCreators = [
   { id: '4', displayName: 'Artist One', handle: 'artist1', category: 'art', avatarUrl: 'http://avatar4.png', isVerified: false, createdAt: new Date(), updatedAt: new Date() },
   { id: '5', displayName: 'Musician One', handle: 'musician1', category: 'music', avatarUrl: 'http://avatar5.png', isVerified: false, createdAt: new Date(), updatedAt: new Date() },
] as unknown as CreatorProfile[];

const mockAllCreators = [...mockMatchingCreators, ...mockNonMatchingCreators];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/v1/creators — total count accuracy after filter', () => {
   beforeEach(() => {
      // Mock fetchCreatorList implementation to return different totals depending on filter
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockImplementation(async (query: any) => {
         if (query.category === 'gaming') {
            return [mockMatchingCreators, mockMatchingCreators.length]; // 3 creators
         }
         return [mockAllCreators, mockAllCreators.length]; // 5 creators
      });
   });

   afterEach(() => {
      jest.restoreAllMocks();
   });

   it('returns filtered items and asserts the total count equals the number of matching creators', async () => {
      const req = makeReq({ category: 'gaming' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);

      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(true);
      expect(body.data.items).toHaveLength(3);

      // Assert the total count equals the number of creators matching the filter
      const totalCount = body.data.meta.total;
      expect(totalCount).toBe(3);

      // Assert the total count differs from the unfiltered total
      expect(totalCount).not.toBe(5);
   });

   it('returns all items and asserts the total count equals the unfiltered total when no filter is applied', async () => {
      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);

      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(true);
      expect(body.data.items).toHaveLength(5);

      // Assert the total count equals the unfiltered total
      expect(body.data.meta.total).toBe(5);
   });

   it('fails if the total count returns the unfiltered value when filtered', async () => {
      const req = makeReq({ category: 'gaming' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      
      // Explicit assertion: the test will fail if body.data.meta.total is the unfiltered count (5)
      // because we expect it to be exactly 3.
      expect(body.data.meta.total).toBe(3);
   });
});
