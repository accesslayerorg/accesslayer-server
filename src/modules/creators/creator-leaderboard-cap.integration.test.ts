// Integration test: leaderboard endpoint is capped at 100 entries even when
// more than 100 creators exist in the database (#cap-leaderboard).
//
// Uses Jest mocks — no database required. Follows the same conventions as
// creator-leaderboard-sort-order.integration.test.ts.
//
// Acceptance criteria verified here:
//   1. Exactly 100 entries returned when more than 100 creators exist.
//   2. Entries are the top 100 by holder count.
//   3. ?limit param above 100 is silently capped at 100.
//   4. Response includes the correct total_count field (all creators, not
//      just the capped slice).

import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findMany: jest.fn(),
      },
      keyOwnership: {
         count: jest.fn(),
      },
      $disconnect: jest.fn(),
   },
}));

const mockPrisma = prisma as unknown as {
   creatorProfile: { findMany: jest.Mock };
   keyOwnership: { count: jest.Mock };
};

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake Stellar-style address that sorts deterministically.
 * Each address is unique and consistently comparable within the fixture set.
 */
function makeAddress(index: number): string {
   const padded = String(index).padStart(6, '0');
   // 56-char Stellar G-address shape (doesn't need to be valid, just unique & sortable)
   return `G${padded}${'A'.repeat(49)}`;
}

interface CreatorFixture {
   id: string;
   address: string;
   holderCount: number;
   currentPrice: bigint;
}

/**
 * Seed 110 creators.
 *
 * Holder counts are assigned so that creators 0–99 have counts
 * 110, 109, …, 11 (the "top 100") and creators 100–109 have counts
 * 10, 9, …, 1 (the "bottom 10" that must be excluded after capping).
 *
 * This gives every creator a distinct holder count so there are no
 * ties to reason about, making assertions straightforward.
 */
const TOTAL_CREATORS = 110;
const CAP = 100;

const FIXTURES: CreatorFixture[] = Array.from(
   { length: TOTAL_CREATORS },
   (_, i) => ({
      id: `creator-${i}`,
      address: makeAddress(i),
      // Creator 0 → 110 holders, creator 1 → 109 holders, …
      // Creator 109 → 1 holder
      holderCount: TOTAL_CREATORS - i,
      currentPrice: BigInt((i + 1) * 1_000_000),
   })
);

// The top 100 by holder count are FIXTURES[0..99] (holderCounts 110..11).
const TOP_100_IDS = new Set(FIXTURES.slice(0, CAP).map(f => f.id));

function mockCreatorProfile(fixture: CreatorFixture) {
   return {
      id: fixture.id,
      handle: fixture.id,
      priceSnapshot: { currentPrice: fixture.currentPrice },
      user: { stellarWallet: { address: fixture.address } },
   };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/v1/creators/leaderboard — 100-entry cap', () => {
   beforeEach(() => {
      jest.clearAllMocks();

      // Return all 110 creator profiles from the mocked DB.
      mockPrisma.creatorProfile.findMany.mockResolvedValue(
         FIXTURES.map(mockCreatorProfile)
      );

      // Return the per-creator holder count keyed by creatorId.
      mockPrisma.keyOwnership.count.mockImplementation(
         async ({ where }: any) => {
            const fixture = FIXTURES.find(f => f.id === where.creatorId);
            return fixture?.holderCount ?? 0;
         }
      );
   });

   it('returns exactly 100 entries when 110 creators exist', async () => {
      const res = await supertest(app).get('/api/v1/creators/leaderboard');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(CAP);
   });

   it('returns the top 100 creators by holder count', async () => {
      const res = await supertest(app).get('/api/v1/creators/leaderboard');

      const items: Array<{ creator: string; holder_count: number }> =
         res.body.data.items;

      // All returned entries must belong to the top-100 fixture set.
      for (const item of items) {
         const fixture = FIXTURES.find(f => f.address === item.creator);
         expect(fixture).toBeDefined();
         expect(TOP_100_IDS.has(fixture!.id)).toBe(true);
      }
   });

   it('returns entries in holder_count descending order', async () => {
      const res = await supertest(app).get('/api/v1/creators/leaderboard');

      const items: Array<{ holder_count: number }> = res.body.data.items;

      for (let i = 0; i < items.length - 1; i++) {
         expect(items[i].holder_count).toBeGreaterThanOrEqual(
            items[i + 1].holder_count
         );
      }

      // The top entry must be the creator with the highest holder count (110).
      expect(items[0].holder_count).toBe(TOTAL_CREATORS);
      // The 100th entry must have holder count 11 (TOTAL_CREATORS - CAP + 1).
      expect(items[CAP - 1].holder_count).toBe(TOTAL_CREATORS - CAP + 1);
   });

   it('assigns sequential rank fields from 1 to 100', async () => {
      const res = await supertest(app).get('/api/v1/creators/leaderboard');

      const ranks: number[] = res.body.data.items.map(
         (entry: any) => entry.rank
      );
      expect(ranks).toEqual(Array.from({ length: CAP }, (_, i) => i + 1));
   });

   it('includes total_count equal to the total number of creators (110)', async () => {
      const res = await supertest(app).get('/api/v1/creators/leaderboard');

      expect(res.body.data.total_count).toBe(TOTAL_CREATORS);
   });

   it('ignores a ?limit param above 100 and still returns exactly 100 entries', async () => {
      const res = await supertest(app)
         .get('/api/v1/creators/leaderboard')
         .query({ limit: 200 });

      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(CAP);
   });

   it('ignores ?limit=9999 and still returns the top 100 by holder count', async () => {
      const res = await supertest(app)
         .get('/api/v1/creators/leaderboard')
         .query({ limit: 9999 });

      const items: Array<{ holder_count: number }> = res.body.data.items;
      expect(items).toHaveLength(CAP);
      // First entry is still the global leader.
      expect(items[0].holder_count).toBe(TOTAL_CREATORS);
   });

   it('respects a ?limit param below 100 and returns the requested number of entries', async () => {
      const res = await supertest(app)
         .get('/api/v1/creators/leaderboard')
         .query({ limit: 10 });

      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(10);

      // The 10 entries must still be the top 10 by holder count.
      const items: Array<{ holder_count: number }> = res.body.data.items;
      expect(items[0].holder_count).toBe(TOTAL_CREATORS); // 110
      expect(items[9].holder_count).toBe(TOTAL_CREATORS - 9); // 101
   });

   it('total_count is unaffected by the limit param', async () => {
      const res = await supertest(app)
         .get('/api/v1/creators/leaderboard')
         .query({ limit: 5 });

      // total_count always reflects the full creator population.
      expect(res.body.data.total_count).toBe(TOTAL_CREATORS);
   });

   it('excludes the bottom 10 creators from the capped response', async () => {
      const res = await supertest(app).get('/api/v1/creators/leaderboard');

      const returnedAddresses = new Set(
         res.body.data.items.map((entry: any) => entry.creator)
      );

      // Creators 100–109 (holderCounts 10..1) must not appear.
      for (const fixture of FIXTURES.slice(CAP)) {
         expect(returnedAddresses.has(fixture.address)).toBe(false);
      }
   });
});
