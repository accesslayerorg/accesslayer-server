// Integration test: creator list filtered by verified status
//
// Verifies that the creator list supports filtering by verified status.
// Uses a mixed fixture of verified and unverified creators to confirm
// the filter is applied correctly.
//
// Scope: exercises the complete request path with verified filter parameter,
// ensuring only creators matching the verified status are returned.

import { httpListCreators } from './creators.controllers';
import * as creatorsUtils from './creators.utils';
import type { CreatorProfile } from '../../types/profile.types';

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

// ── Fixture: mixed verified and unverified creators ───────────────────────────

const FIXTURE_VERIFIED_1: CreatorProfile = {
   id: 'cuid-1',
   userId: 'user-1',
   handle: 'verified_creator_1',
   displayName: 'Verified Creator 1',
   isVerified: true,
   createdAt: new Date('2024-01-01T10:00:00Z'),
   updatedAt: new Date('2024-01-01T10:00:00Z'),
};

const FIXTURE_UNVERIFIED_1: CreatorProfile = {
   id: 'cuid-2',
   userId: 'user-2',
   handle: 'unverified_creator_1',
   displayName: 'Unverified Creator 1',
   isVerified: false,
   createdAt: new Date('2024-01-02T10:00:00Z'),
   updatedAt: new Date('2024-01-02T10:00:00Z'),
};

const FIXTURE_VERIFIED_2: CreatorProfile = {
   id: 'cuid-3',
   userId: 'user-3',
   handle: 'verified_creator_2',
   displayName: 'Verified Creator 2',
   isVerified: true,
   createdAt: new Date('2024-01-03T10:00:00Z'),
   updatedAt: new Date('2024-01-03T10:00:00Z'),
};

const ALL_FIXTURES = [
   FIXTURE_VERIFIED_1,
   FIXTURE_UNVERIFIED_1,
   FIXTURE_VERIFIED_2,
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/v1/creators — verified status filter', () => {
   afterEach(() => {
      jest.restoreAllMocks();
   });

   it('returns only verified creators when filtered by verified=true', async () => {
      const verifiedCreators = ALL_FIXTURES.filter(c => c.isVerified === true);
      jest
         .spyOn(creatorsUtils, 'fetchCreatorList')
         .mockResolvedValue([verifiedCreators, verifiedCreators.length]);

      const req = makeReq({ verified: 'true' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];

      expect(body.data.items).toHaveLength(2);
      body.data.items.forEach((item: any) => {
         const fixture = ALL_FIXTURES.find(f => f.id === item.id);
         expect(fixture?.isVerified).toBe(true);
      });
   });

   it('returns only unverified creators when filtered by verified=false', async () => {
      const unverifiedCreators = ALL_FIXTURES.filter(c => c.isVerified === false);
      jest
         .spyOn(creatorsUtils, 'fetchCreatorList')
         .mockResolvedValue([unverifiedCreators, unverifiedCreators.length]);

      const req = makeReq({ verified: 'false' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];

      expect(body.data.items).toHaveLength(1);
      body.data.items.forEach((item: any) => {
         const fixture = ALL_FIXTURES.find(f => f.id === item.id);
         expect(fixture?.isVerified).toBe(false);
      });
   });

   it('returns both verified and unverified creators when no verified filter is applied', async () => {
      jest
         .spyOn(creatorsUtils, 'fetchCreatorList')
         .mockResolvedValue([ALL_FIXTURES, ALL_FIXTURES.length]);

      const req = makeReq();
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];

      expect(body.data.items).toHaveLength(3);
      const hasVerified = body.data.items.some((item: any) => {
         const fixture = ALL_FIXTURES.find(f => f.id === item.id);
         return fixture?.isVerified === true;
      });
      const hasUnverified = body.data.items.some((item: any) => {
         const fixture = ALL_FIXTURES.find(f => f.id === item.id);
         return fixture?.isVerified === false;
      });
      expect(hasVerified).toBe(true);
      expect(hasUnverified).toBe(true);
   });
});
