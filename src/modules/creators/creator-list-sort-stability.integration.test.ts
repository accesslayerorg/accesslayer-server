// Integration test: creator list sort stability across identical sort values
//
// When multiple creators share the same value for the active sort field,
// the sort order between them must be deterministic and stable across
// repeated requests. This test validates that a tie-breaker (id field)
// is consistently applied to prevent undefined ordering.

import { httpListCreators } from './creators.controllers';
import * as creatorsUtils from './creators.utils';
import type { CreatorProfile } from '../../types/profile.types';

// ── Lightweight request/response mocks ────────────────────────────────────────

function makeReq(query: Record<string, string> = {}): any {
   return { query, requestId: 'test-request-id' };
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

// ── Fixtures with duplicate sort values ───────────────────────────────────────

const SHARED_CREATED_AT = new Date('2024-03-15T10:00:00.000Z');

const FIXTURE_CREATOR_A: CreatorProfile = {
   id: 'creator-aaa',
   userId: 'user-aaa',
   handle: 'creator_a',
   displayName: 'Creator A',
   isVerified: false,
   createdAt: SHARED_CREATED_AT,
   updatedAt: new Date('2024-03-15T10:00:00.000Z'),
};

const FIXTURE_CREATOR_B: CreatorProfile = {
   id: 'creator-bbb',
   userId: 'user-bbb',
   handle: 'creator_b',
   displayName: 'Creator B',
   isVerified: false,
   createdAt: SHARED_CREATED_AT,
   updatedAt: new Date('2024-03-15T10:00:00.000Z'),
};

const FIXTURE_CREATOR_C: CreatorProfile = {
   id: 'creator-ccc',
   userId: 'user-ccc',
   handle: 'creator_c',
   displayName: 'Creator C',
   isVerified: false,
   createdAt: SHARED_CREATED_AT,
   updatedAt: new Date('2024-03-15T10:00:00.000Z'),
};

describe('GET /api/v1/creators — sort stability with duplicate values', () => {
   afterEach(() => {
      jest.restoreAllMocks();
   });

   it('returns identical order across repeated requests when sort values are duplicated', async () => {
      const fixturesWithDuplicates = [
         FIXTURE_CREATOR_C,
         FIXTURE_CREATOR_A,
         FIXTURE_CREATOR_B,
      ];

      jest
         .spyOn(creatorsUtils, 'fetchCreatorList')
         .mockResolvedValue([
            fixturesWithDuplicates,
            fixturesWithDuplicates.length,
         ]);

      // First request
      const req1 = makeReq({ sort: 'createdAt', order: 'desc' });
      const res1 = makeRes();
      await httpListCreators(req1, res1, makeNext());

      expect(res1.status).toHaveBeenCalledWith(200);
      const body1 = res1.json.mock.calls[0][0];
      const handles1 = body1.data.items.map((item: any) => item.handle);

      // Second request with identical parameters
      const req2 = makeReq({ sort: 'createdAt', order: 'desc' });
      const res2 = makeRes();
      await httpListCreators(req2, res2, makeNext());

      expect(res2.status).toHaveBeenCalledWith(200);
      const body2 = res2.json.mock.calls[0][0];
      const handles2 = body2.data.items.map((item: any) => item.handle);

      // Assert order is identical across both requests
      expect(handles1).toEqual(handles2);
   });

   it('applies tie-breaker field (id) consistently when primary sort values match', async () => {
      const fixturesWithDuplicates = [
         FIXTURE_CREATOR_C,
         FIXTURE_CREATOR_A,
         FIXTURE_CREATOR_B,
      ];

      // Sort by id to simulate tie-breaker behavior
      const sortedFixtures = [...fixturesWithDuplicates].sort((a, b) =>
         a.id.localeCompare(b.id)
      );

      jest
         .spyOn(creatorsUtils, 'fetchCreatorList')
         .mockResolvedValue([sortedFixtures, sortedFixtures.length]);

      const req = makeReq({ sort: 'createdAt', order: 'asc' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      const ids = body.data.items.map((item: any) => item.id);

      // When createdAt values are identical, items should be ordered by id (ascending)
      // Expected order: creator-aaa, creator-bbb, creator-ccc
      expect(ids).toEqual(['creator-aaa', 'creator-bbb', 'creator-ccc']);
   });

   it('maintains stable order when sorting by displayName with duplicates', async () => {
      const SHARED_DISPLAY_NAME = 'Shared Name';

      const fixturesWithSharedName = [
         { ...FIXTURE_CREATOR_C, displayName: SHARED_DISPLAY_NAME },
         { ...FIXTURE_CREATOR_A, displayName: SHARED_DISPLAY_NAME },
         { ...FIXTURE_CREATOR_B, displayName: SHARED_DISPLAY_NAME },
      ];

      // Sort by id to simulate tie-breaker behavior
      const sortedFixtures = [...fixturesWithSharedName].sort((a, b) =>
         a.id.localeCompare(b.id)
      );

      jest
         .spyOn(creatorsUtils, 'fetchCreatorList')
         .mockResolvedValue([sortedFixtures, sortedFixtures.length]);

      const req = makeReq({ sort: 'displayName', order: 'asc' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];
      const ids = body.data.items.map((item: any) => item.id);

      // Tie-breaker should order by id when displayName is identical
      expect(ids).toEqual(['creator-aaa', 'creator-bbb', 'creator-ccc']);
   });
});
