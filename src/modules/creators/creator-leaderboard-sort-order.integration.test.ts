// Integration test: leaderboard endpoint returns creators sorted by
// holder count descending, with alphabetical tie-breaking by creator
// address (#680).
//
// Uses Jest mocks — no database required. Follows the same conventions
// as trending-creators.integration.test.ts (the sibling ranked-list
// endpoint in this module).

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

// Two creators tie on holder count (50); their addresses are chosen so
// the alphabetically-earlier one ("GAAA...") must outrank the later one
// ("GBBB...") once the tie-break is applied.
const CREATOR_HIGH_A = {
   id: 'creator-high-a',
   handle: 'high-a',
   address: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
   holderCount: 50,
   currentPrice: 2_000_000n,
};
const CREATOR_HIGH_B = {
   id: 'creator-high-b',
   handle: 'high-b',
   address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB',
   holderCount: 50,
   currentPrice: 3_000_000n,
};
const CREATOR_LOW = {
   id: 'creator-low',
   handle: 'low',
   address: 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
   holderCount: 20,
   currentPrice: 500_000n,
};

function mockCreatorProfile(fixture: typeof CREATOR_HIGH_A) {
   return {
      id: fixture.id,
      handle: fixture.handle,
      priceSnapshot: { currentPrice: fixture.currentPrice },
      user: { stellarWallet: { address: fixture.address } },
   };
}

describe('GET /api/v1/creators/leaderboard', () => {
   beforeEach(() => {
      jest.clearAllMocks();

      // Seed three creators: two tied at 50 holders, one at 20.
      mockPrisma.creatorProfile.findMany.mockResolvedValue([
         mockCreatorProfile(CREATOR_HIGH_A),
         mockCreatorProfile(CREATOR_HIGH_B),
         mockCreatorProfile(CREATOR_LOW),
      ]);

      mockPrisma.keyOwnership.count.mockImplementation(
         async ({ where }: any) => {
            const byId: Record<string, number> = {
               [CREATOR_HIGH_A.id]: CREATOR_HIGH_A.holderCount,
               [CREATOR_HIGH_B.id]: CREATOR_HIGH_B.holderCount,
               [CREATOR_LOW.id]: CREATOR_LOW.holderCount,
            };
            return byId[where.creatorId] ?? 0;
         }
      );
   });

   it('ranks the two 50-holder creators above the 20-holder creator', async () => {
      const res = await supertest(app).get('/api/v1/creators/leaderboard');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const items = res.body.data.items;
      expect(items).toHaveLength(3);

      expect(items[0].holder_count).toBe(50);
      expect(items[1].holder_count).toBe(50);
      expect(items[2].holder_count).toBe(20);

      // The 20-holder creator is ranked last.
      expect(items[2].creator).toBe(CREATOR_LOW.address);
   });

   it('includes total_count equal to the number of creators in the database', async () => {
      const res = await supertest(app).get('/api/v1/creators/leaderboard');

      expect(res.status).toBe(200);
      // Three creators were seeded; all three are below the 100-entry cap.
      expect(res.body.data.total_count).toBe(3);
   });

   it('breaks the tie between equal holder counts alphabetically by creator address', async () => {
      const res = await supertest(app).get('/api/v1/creators/leaderboard');

      const items = res.body.data.items;
      const tied = items.slice(0, 2);

      expect(tied.map((entry: any) => entry.creator)).toEqual(
         [CREATOR_HIGH_A.address, CREATOR_HIGH_B.address].sort()
      );
      // GAAA...B sorts before GBBB...B alphabetically.
      expect(tied[0].creator).toBe(CREATOR_HIGH_B.address);
      expect(tied[1].creator).toBe(CREATOR_HIGH_A.address);
   });

   it('assigns sequential rank fields starting at 1', async () => {
      const res = await supertest(app).get('/api/v1/creators/leaderboard');

      const items = res.body.data.items;
      expect(items.map((entry: any) => entry.rank)).toEqual([1, 2, 3]);
   });

   it('includes rank, creator, holder_count, and current_price on every entry', async () => {
      const res = await supertest(app).get('/api/v1/creators/leaderboard');

      const items = res.body.data.items;
      for (const entry of items) {
         expect(entry).toEqual(
            expect.objectContaining({
               rank: expect.any(Number),
               creator: expect.any(String),
               holder_count: expect.any(Number),
               current_price: expect.any(String),
            })
         );
      }
   });

   it('reflects each creator current_price from its price snapshot', async () => {
      const res = await supertest(app).get('/api/v1/creators/leaderboard');

      const items = res.body.data.items;
      const lowEntry = items.find(
         (entry: any) => entry.creator === CREATOR_LOW.address
      );
      expect(lowEntry.current_price).toBe(CREATOR_LOW.currentPrice.toString());
   });
});
