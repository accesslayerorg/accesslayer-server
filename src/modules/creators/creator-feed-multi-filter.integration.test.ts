// Integration test: creator feed with multiple category filters simultaneously
//
// Verifies that the controller correctly passes multiple filter parameters to the
// service layer and that the response envelope reflects non-empty fixture data.
// Uses Jest mocks with a real in-memory fixture set — no database required.
//
// Scope: exercises the filter combinator path end-to-end through the HTTP layer:
//   query → schema validation → fetchCreatorList (mocked) → serialization → envelope

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

// ── Fixture creators spanning multiple filter categories ──────────────────────
//
// Each creator belongs to one or more "categories":
//   • Verified status (isVerified true/false)
//   • Handle/displayName searchability (contains "jazz" or "rock")
//
// Keeping fixtures deterministic and minimal so assertions remain readable.

const FIXTURE_VERIFIED_JAZZ: CreatorProfile = {
   id: 'cuid-1',
   userId: 'user-1',
   handle: 'alice_jazz',
   displayName: 'Alice Jazz',
   isVerified: true,
   createdAt: new Date('2024-01-01'),
   updatedAt: new Date('2024-01-01'),
};

const FIXTURE_VERIFIED_ROCK: CreatorProfile = {
   id: 'cuid-2',
   userId: 'user-2',
   handle: 'bob_rock',
   displayName: 'Bob Rock',
   isVerified: true,
   createdAt: new Date('2024-01-02'),
   updatedAt: new Date('2024-01-02'),
};

const FIXTURE_UNVERIFIED_JAZZ: CreatorProfile = {
   id: 'cuid-3',
   userId: 'user-3',
   handle: 'carol_jazz',
   displayName: 'Carol Jazz',
   isVerified: false,
   createdAt: new Date('2024-01-03'),
   updatedAt: new Date('2024-01-03'),
};

const FIXTURE_UNVERIFIED_ROCK: CreatorProfile = {
   id: 'cuid-4',
   userId: 'user-4',
   handle: 'dave_rock',
   displayName: 'Dave Rock',
   isVerified: false,
   createdAt: new Date('2024-01-04'),
   updatedAt: new Date('2024-01-04'),
};

// Full fixture set
const ALL_FIXTURES = [
   FIXTURE_VERIFIED_JAZZ,
   FIXTURE_VERIFIED_ROCK,
   FIXTURE_UNVERIFIED_JAZZ,
   FIXTURE_UNVERIFIED_ROCK,
];

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /api/v1/creators — multiple category filters with fixture data', () => {
   afterEach(() => {
      jest.restoreAllMocks();
   });

   // ── Multi-filter: verified + search ────────────────────────────────────────

   it('passes verified=true and search together to fetchCreatorList', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         [FIXTURE_VERIFIED_JAZZ],
         1,
      ]);

      const req = makeReq({ verified: 'true', search: 'jazz' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(creatorsUtils.fetchCreatorList).toHaveBeenCalledWith(
         expect.objectContaining({
            verified: true,
            search: 'jazz',
         })
      );
   });

   it('returns only the creators the service resolved for verified=true + search=jazz', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         [FIXTURE_VERIFIED_JAZZ],
         1,
      ]);

      const req = makeReq({ verified: 'true', search: 'jazz' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.success).toBe(true);
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0].id).toBe(FIXTURE_VERIFIED_JAZZ.id);
      expect(body.data.items[0].name).toBe(FIXTURE_VERIFIED_JAZZ.displayName);
   });

   it('returns correct pagination metadata for verified=true + search=jazz (1 result)', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         [FIXTURE_VERIFIED_JAZZ],
         1,
      ]);

      const req = makeReq({ verified: 'true', search: 'jazz' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.meta.total).toBe(1);
      expect(body.data.meta.hasMore).toBe(false);
      expect(body.data.meta.offset).toBe(0);
   });

   it('passes verified=false and search together to fetchCreatorList', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         [FIXTURE_UNVERIFIED_ROCK],
         1,
      ]);

      const req = makeReq({ verified: 'false', search: 'rock' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(creatorsUtils.fetchCreatorList).toHaveBeenCalledWith(
         expect.objectContaining({
            verified: false,
            search: 'rock',
         })
      );
   });

   it('returns only unverified-rock creator for verified=false + search=rock', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         [FIXTURE_UNVERIFIED_ROCK],
         1,
      ]);

      const req = makeReq({ verified: 'false', search: 'rock' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0].id).toBe(FIXTURE_UNVERIFIED_ROCK.id);
   });

   // ── Multi-filter: verified + search + pagination ───────────────────────────

   it('passes verified, search, limit, and offset together to fetchCreatorList', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         [FIXTURE_VERIFIED_JAZZ, FIXTURE_VERIFIED_ROCK],
         2,
      ]);

      const req = makeReq({ verified: 'true', search: 'test', limit: '5', offset: '0' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(creatorsUtils.fetchCreatorList).toHaveBeenCalledWith(
         expect.objectContaining({
            verified: true,
            search: 'test',
            limit: 5,
            offset: 0,
         })
      );
   });

   it('pagination metadata reflects total from service when multiple filters applied', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         [FIXTURE_VERIFIED_JAZZ],
         10, // total = 10 (paginated result)
      ]);

      const req = makeReq({ verified: 'true', limit: '1', offset: '0' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.items).toHaveLength(1);
      expect(body.data.meta.total).toBe(10);
      expect(body.data.meta.limit).toBe(1);
      expect(body.data.meta.offset).toBe(0);
      expect(body.data.meta.hasMore).toBe(true);
   });

   it('hasMore is true when total exceeds limit+offset with multiple filters active', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         [FIXTURE_VERIFIED_JAZZ, FIXTURE_VERIFIED_ROCK],
         20,
      ]);

      const req = makeReq({ verified: 'true', search: 'test', limit: '2', offset: '0' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.meta.hasMore).toBe(true);
      expect(body.data.meta.total).toBe(20);
   });

   it('hasMore is false when all results fit within limit+offset', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         [FIXTURE_VERIFIED_JAZZ, FIXTURE_VERIFIED_ROCK],
         2,
      ]);

      const req = makeReq({ verified: 'true', search: 'test', limit: '10', offset: '0' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.meta.hasMore).toBe(false);
      expect(body.data.meta.total).toBe(2);
   });

   // ── Multi-filter: verified + sort + order ──────────────────────────────────

   it('passes verified, sort, and order together to fetchCreatorList', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         [FIXTURE_VERIFIED_JAZZ, FIXTURE_VERIFIED_ROCK],
         2,
      ]);

      const req = makeReq({ verified: 'true', sort: 'displayName', order: 'asc' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(creatorsUtils.fetchCreatorList).toHaveBeenCalledWith(
         expect.objectContaining({
            verified: true,
            sort: 'displayName',
            order: 'asc',
         })
      );
   });

   it('serializes multiple fixture items correctly for verified + sort combo', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         [FIXTURE_VERIFIED_JAZZ, FIXTURE_VERIFIED_ROCK],
         2,
      ]);

      const req = makeReq({ verified: 'true', sort: 'displayName', order: 'asc' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.items).toHaveLength(2);
      const ids = body.data.items.map((item: any) => item.id);
      expect(ids).toContain(FIXTURE_VERIFIED_JAZZ.id);
      expect(ids).toContain(FIXTURE_VERIFIED_ROCK.id);
   });

   // ── Full fixture set: all four creators ───────────────────────────────────

   it('returns all fixture creators with no filter applied', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         ALL_FIXTURES,
         ALL_FIXTURES.length,
      ]);

      const req = makeReq({});
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.items).toHaveLength(4);
      expect(body.data.meta.total).toBe(4);
      expect(body.data.meta.hasMore).toBe(false);
   });

   it('items field is always an array for every multi-filter combo', async () => {
      const filterCombinations: Record<string, string>[] = [
         { verified: 'true', search: 'jazz' },
         { verified: 'false', search: 'rock' },
         { verified: 'true', sort: 'displayName', order: 'asc' },
         { verified: 'false', sort: 'createdAt', order: 'desc' },
         { search: 'jazz', limit: '2', offset: '0' },
         { verified: 'true', search: 'rock', limit: '5', offset: '0' },
      ];

      for (const query of filterCombinations) {
         jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
            [FIXTURE_VERIFIED_JAZZ],
            1,
         ]);

         const req = makeReq(query);
         const res = makeRes();
         await httpListCreators(req, res, makeNext());

         const body = res.json.mock.calls[0][0];
         expect(body.success).toBe(true);
         expect(Array.isArray(body.data.items)).toBe(true);
         expect(body.data).toHaveProperty('meta');

         jest.restoreAllMocks();
      }
   });

   // ── Serialized item shape ──────────────────────────────────────────────────

   it('each item in the response has the expected public shape', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         [FIXTURE_VERIFIED_JAZZ],
         1,
      ]);

      const req = makeReq({ verified: 'true', search: 'jazz' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      const item = body.data.items[0];
      expect(item).toHaveProperty('id', FIXTURE_VERIFIED_JAZZ.id);
      expect(item).toHaveProperty('name', FIXTURE_VERIFIED_JAZZ.displayName);
      expect(item).toHaveProperty('avatar');
      expect(item).toHaveProperty('followers');
      // Internal fields must not leak through
      expect(item).not.toHaveProperty('isVerified');
      expect(item).not.toHaveProperty('userId');
      expect(item).not.toHaveProperty('handle');
   });

   it('pagination metadata has all required fields for any multi-filter combo', async () => {
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([
         [FIXTURE_VERIFIED_JAZZ, FIXTURE_UNVERIFIED_JAZZ],
         2,
      ]);

      const req = makeReq({ search: 'jazz', sort: 'createdAt', order: 'asc' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      const body = res.json.mock.calls[0][0];
      expect(body.data.meta).toMatchObject({
         total: 2,
         hasMore: false,
         limit: expect.any(Number),
         offset: expect.any(Number),
      });
   });
});
