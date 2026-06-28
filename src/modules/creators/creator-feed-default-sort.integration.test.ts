// Integration test: creator list default sort when sort is omitted
//
// Ensures the creator list handler applies the documented default sort field/order
// when the client omits the `sort` query param, returning a stable response.

import { httpListCreators } from './creators.controllers';
import * as creatorsUtils from './creators.utils';
import type { CreatorProfile } from '../../types/profile.types';
import {
   DEFAULT_CREATOR_LIST_ORDER,
   DEFAULT_CREATOR_LIST_SORT,
} from '../../constants/creator-list-sort.constants';

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

// ── Fixtures ─────────────────────────────────────────────────────────────────

const FIXTURE_OLD: CreatorProfile = {
   id: 'cuid-old',
   userId: 'user-old',
   handle: 'old_creator',
   displayName: 'Old Creator',
   isVerified: false,
   createdAt: new Date('2024-01-01T00:00:00.000Z'),
   updatedAt: new Date('2024-01-01T00:00:00.000Z'),
};

const FIXTURE_NEW: CreatorProfile = {
   id: 'cuid-new',
   userId: 'user-new',
   handle: 'new_creator',
   displayName: 'New Creator',
   isVerified: true,
   createdAt: new Date('2024-02-01T00:00:00.000Z'),
   updatedAt: new Date('2024-02-01T00:00:00.000Z'),
};

describe('GET /api/v1/creators — default sort when sort is omitted', () => {
   afterEach(() => {
      jest.restoreAllMocks();
   });

   it('returns 200, applies default sort, and responds with well-formed pagination meta', async () => {
      const fixturesOutOfOrder = [FIXTURE_OLD, FIXTURE_NEW];

      jest
         .spyOn(creatorsUtils, 'fetchCreatorList')
         .mockImplementation(async (query: any) => {
            // The schema should supply defaults when `sort` is omitted.
            expect(query.sort).toBe(DEFAULT_CREATOR_LIST_SORT);
            expect(query.order).toBe(DEFAULT_CREATOR_LIST_ORDER);

            // Return items in the expected default order (createdAt desc).
            const sorted = [...fixturesOutOfOrder].sort(
               (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
            );
            return [sorted, sorted.length];
         });

      // No `sort` query param provided.
      const req = makeReq({});
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];

      expect(body).toHaveProperty('success', true);
      expect(body).toHaveProperty('data');

      // Items are serialized via creator list mappers — assert order.
      expect(Array.isArray(body.data.items)).toBe(true);
      expect(body.data.items).toHaveLength(2);
      expect(body.data.items[0].name).toBe('New Creator');
      expect(body.data.items[1].name).toBe('Old Creator');

      // Pagination meta should be present and well-formed.
      expect(body.data).toHaveProperty('meta');
      expect(body.data.meta).toEqual(
         expect.objectContaining({
            limit: expect.any(Number),
            offset: 0,
            total: 2,
            hasMore: false,
         })
      );
   });
});

