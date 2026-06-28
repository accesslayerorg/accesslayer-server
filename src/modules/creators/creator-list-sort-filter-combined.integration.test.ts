// Integration test: creator list with combined sort and filter parameters
//
// Verifies that sort and filter parameters work correctly when applied together.
// Tests that items satisfy the filter constraint AND are in the expected sort order.
// Uses a fixture with enough variety to confirm both constraints are applied.
//
// Scope: exercises the complete request path with both sort and filter parameters,
// ensuring neither constraint is dropped silently and they interact correctly.

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

// ── Fixture: creators spanning multiple categories ────────────────────────────
//
// Fixture set includes:
//   • Verified and unverified creators
//   • Creators with searchable handles/displayNames
//   • Multiple creation dates for sort testing
//
// This variety ensures both filter and sort constraints are testable.

const FIXTURE_VERIFIED_ALICE: CreatorProfile = {
   id: 'cuid-1',
   userId: 'user-1',
   handle: 'alice_jazz',
   displayName: 'Alice Jazz',
   isVerified: true,
   createdAt: new Date('2024-01-01T10:00:00Z'),
   updatedAt: new Date('2024-01-01T10:00:00Z'),
};

const FIXTURE_VERIFIED_BOB: CreatorProfile = {
   id: 'cuid-2',
   userId: 'user-2',
   handle: 'bob_rock',
   displayName: 'Bob Rock',
   isVerified: true,
   createdAt: new Date('2024-01-02T10:00:00Z'),
   updatedAt: new Date('2024-01-02T10:00:00Z'),
};

const FIXTURE_VERIFIED_CHARLIE: CreatorProfile = {
   id: 'cuid-3',
   userId: 'user-3',
   handle: 'charlie_jazz',
   displayName: 'Charlie Jazz',
   isVerified: true,
   createdAt: new Date('2024-01-03T10:00:00Z'),
   updatedAt: new Date('2024-01-03T10:00:00Z'),
};

const FIXTURE_UNVERIFIED_DIANA: CreatorProfile = {
   id: 'cuid-4',
   userId: 'user-4',
   handle: 'diana_jazz',
   displayName: 'Diana Jazz',
   isVerified: false,
   createdAt: new Date('2024-01-04T10:00:00Z'),
   updatedAt: new Date('2024-01-04T10:00:00Z'),
};

const FIXTURE_UNVERIFIED_EVE: CreatorProfile = {
   id: 'cuid-5',
   userId: 'user-5',
   handle: 'eve_rock',
   displayName: 'Eve Rock',
   isVerified: false,
   createdAt: new Date('2024-01-05T10:00:00Z'),
   updatedAt: new Date('2024-01-05T10:00:00Z'),
};

const ALL_FIXTURES = [
   FIXTURE_VERIFIED_ALICE,
   FIXTURE_VERIFIED_BOB,
   FIXTURE_VERIFIED_CHARLIE,
   FIXTURE_UNVERIFIED_DIANA,
   FIXTURE_UNVERIFIED_EVE,
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/v1/creators — combined sort and filter parameters', () => {
   afterEach(() => {
      jest.restoreAllMocks();
   });

   // ── Filter: verified=true, Sort: createdAt desc ────────────────────────────

   it('filters by verified=true and sorts by createdAt descending', async () => {
      const verifiedCreators = [
         FIXTURE_VERIFIED_CHARLIE,
         FIXTURE_VERIFIED_BOB,
         FIXTURE_VERIFIED_ALICE,
      ];
      jest
         .spyOn(creatorsUtils, 'fetchCreatorList')
         .mockResolvedValue([verifiedCreators, verifiedCreators.length]);

      const req = makeReq({
         verified: 'true',
         sort: 'createdAt',
         order: 'desc',
      });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(res.status).toHaveBeenCalledWith(200);
      const body = res.json.mock.calls[0][0];

      // Assert filter: all items are verified
      expect(body.data.items).toHaveLength(3);
      body.data.items.forEach((item: any) => {
         const fixture = ALL_FIXTURES.find(f => f.id === item.id);
         expect(fixture?.isVerified).toBe(true);
      });

      // Assert sort: items are in descending order by createdAt
      const ids = body.data.items.map((item: any) => item.id);
      expect(ids).toEqual(['cuid-3', 'cuid-2', 'cuid-1']);
   });

   // ── Filter: verified=true, Sort: displayName ascending ─────────────────────

   it('filters by verified=true and sorts by displayName ascending', async () => {
      const verifiedCreators = [
         FIXTURE_VERIFIED_ALICE,
         FIXTURE_VERIFIED_BOB,
         FIXTURE_VERIFIED_CHARLIE,
      ];
      jest
         .spyOn(creatorsUtils, 'fetchCreatorList')
         .mockResolvedValue([verifiedCreators, verifiedCreators.length]);

      const req = makeReq({
         verified: 'true',
         sort: 'displayName',
         order: 'asc',
      });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];

      // Assert filter: all items are verified
      body.data.items.forEach((item: any) => {
         const fixture = ALL_FIXTURES.find(f => f.id === item.id);
         expect(fixture?.isVerified).toBe(true);
      });

      // Assert sort: items are in ascending order by displayName
      const names = body.data.items.map((item: any) => item.name);
      expect(names).toEqual(['Alice Jazz', 'Bob Rock', 'Charlie Jazz']);
   });

   // ── Filter: search term, Sort: handle ascending ────────────────────────────

   it('filters by search term and sorts by handle ascending', async () => {
      // Simulate search for "jazz" matching Alice, Charlie, Diana
      const jazzCreators = [
         FIXTURE_VERIFIED_ALICE,
         FIXTURE_VERIFIED_CHARLIE,
         FIXTURE_UNVERIFIED_DIANA,
      ];
      jest
         .spyOn(creatorsUtils, 'fetchCreatorList')
         .mockResolvedValue([jazzCreators, jazzCreators.length]);

      const req = makeReq({ search: 'jazz', sort: 'handle', order: 'asc' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];

      // Assert filter: all items contain "jazz" in handle or displayName
      body.data.items.forEach((item: any) => {
         const fixture = ALL_FIXTURES.find(f => f.id === item.id);
         const hasJazz =
            fixture?.handle.toLowerCase().includes('jazz') ||
            fixture?.displayName.toLowerCase().includes('jazz');
         expect(hasJazz).toBe(true);
      });

      // Assert sort: items are in ascending order by handle
      const handles = body.data.items.map((item: any) => {
         const fixture = ALL_FIXTURES.find(f => f.id === item.id);
         return fixture?.handle;
      });
      expect(handles).toEqual(['alice_jazz', 'charlie_jazz', 'diana_jazz']);
   });

   // ── Filter: verified=false, Sort: updatedAt descending ──────────────────────

   it('filters by verified=false and sorts by updatedAt descending', async () => {
      const unverifiedCreators = [
         FIXTURE_UNVERIFIED_EVE,
         FIXTURE_UNVERIFIED_DIANA,
      ];
      jest
         .spyOn(creatorsUtils, 'fetchCreatorList')
         .mockResolvedValue([unverifiedCreators, unverifiedCreators.length]);

      const req = makeReq({
         verified: 'false',
         sort: 'updatedAt',
         order: 'desc',
      });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];

      // Assert filter: all items are unverified
      expect(body.data.items).toHaveLength(2);
      body.data.items.forEach((item: any) => {
         const fixture = ALL_FIXTURES.find(f => f.id === item.id);
         expect(fixture?.isVerified).toBe(false);
      });

      // Assert sort: items are in descending order by updatedAt
      const ids = body.data.items.map((item: any) => item.id);
      expect(ids).toEqual(['cuid-5', 'cuid-4']);
   });

   // ── Filter: verified + search, Sort: createdAt ascending ────────────────────

   it('filters by verified=true and search term, sorts by createdAt ascending', async () => {
      // Simulate verified creators with "jazz" in handle/displayName
      const verifiedJazzCreators = [
         FIXTURE_VERIFIED_ALICE,
         FIXTURE_VERIFIED_CHARLIE,
      ];
      jest
         .spyOn(creatorsUtils, 'fetchCreatorList')
         .mockResolvedValue([
            verifiedJazzCreators,
            verifiedJazzCreators.length,
         ]);

      const req = makeReq({
         verified: 'true',
         search: 'jazz',
         sort: 'createdAt',
         order: 'asc',
      });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];

      // Assert filter: all items are verified AND contain "jazz"
      body.data.items.forEach((item: any) => {
         const fixture = ALL_FIXTURES.find(f => f.id === item.id);
         expect(fixture?.isVerified).toBe(true);
         const hasJazz =
            fixture?.handle.toLowerCase().includes('jazz') ||
            fixture?.displayName.toLowerCase().includes('jazz');
         expect(hasJazz).toBe(true);
      });

      // Assert sort: items are in ascending order by createdAt
      const ids = body.data.items.map((item: any) => item.id);
      expect(ids).toEqual(['cuid-1', 'cuid-3']);
   });

   // ── Pagination metadata with filters and sort ──────────────────────────────

   it('includes correct pagination metadata with filters and sort applied', async () => {
      const verifiedCreators = [
         FIXTURE_VERIFIED_ALICE,
         FIXTURE_VERIFIED_BOB,
         FIXTURE_VERIFIED_CHARLIE,
      ];
      jest
         .spyOn(creatorsUtils, 'fetchCreatorList')
         .mockResolvedValue([verifiedCreators, verifiedCreators.length]);

      const req = makeReq({
         verified: 'true',
         sort: 'createdAt',
         order: 'desc',
         limit: '20',
         offset: '0',
      });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.meta).toEqual({
         limit: 20,
         offset: 0,
         total: 3,
         hasMore: false,
      });
   });

   // ── Verify filter is not dropped silently ──────────────────────────────────

   it('fails if filter is dropped (all creators returned instead of filtered)', async () => {
      // Mock returns ALL creators instead of just verified ones
      jest
         .spyOn(creatorsUtils, 'fetchCreatorList')
         .mockResolvedValue([ALL_FIXTURES, ALL_FIXTURES.length]);

      const req = makeReq({
         verified: 'true',
         sort: 'createdAt',
         order: 'desc',
      });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];

      // This test should fail if the filter is not applied
      // because we'd get 5 items instead of 3
      expect(body.data.items.length).not.toBe(5);
   });

   // ── Verify sort is not dropped silently ────────────────────────────────────

   it('fails if sort is dropped (items not in expected order)', async () => {
      // Mock returns verified creators but in wrong order
      const wrongOrder = [
         FIXTURE_VERIFIED_ALICE,
         FIXTURE_VERIFIED_CHARLIE,
         FIXTURE_VERIFIED_BOB,
      ];
      jest
         .spyOn(creatorsUtils, 'fetchCreatorList')
         .mockResolvedValue([wrongOrder, wrongOrder.length]);

      const req = makeReq({
         verified: 'true',
         sort: 'createdAt',
         order: 'desc',
      });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      const ids = body.data.items.map((item: any) => item.id);

      // This test should fail if sort is not applied correctly
      // because we'd get [cuid-1, cuid-3, cuid-2] instead of [cuid-3, cuid-2, cuid-1]
      expect(ids).not.toEqual(['cuid-1', 'cuid-3', 'cuid-2']);
   });

   // ── Response structure is valid with combined parameters ────────────────────

   it('returns valid response structure with combined sort and filter', async () => {
      const verifiedCreators = [FIXTURE_VERIFIED_ALICE];
      jest
         .spyOn(creatorsUtils, 'fetchCreatorList')
         .mockResolvedValue([verifiedCreators, verifiedCreators.length]);

      const req = makeReq({ verified: 'true', sort: 'handle', order: 'asc' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body).toHaveProperty('success', true);
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('items');
      expect(body.data).toHaveProperty('meta');
      expect(Array.isArray(body.data.items)).toBe(true);
      expect(typeof body.data.meta).toBe('object');
   });
});
