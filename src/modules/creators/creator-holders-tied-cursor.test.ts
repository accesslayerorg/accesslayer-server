// Unit test: fetchCreatorHolders correctly applies the pagination cursor
// (offset) when the holder count (balance) field is tied across holders.
//
// When two or more holders share the same key count, the query's secondary
// sort (wallet address ascending) must produce a fully deterministic order.
// This guarantees that paging through the list — even when a tied group
// straddles a page boundary — never duplicates or skips a row.
//
// Uses Jest mocks — no database required. The mocked `findMany` simulates a
// real ORDER BY (balance desc, ownerAddress asc) + skip/take, which is the
// contract fetchCreatorHolders relies on the database to uphold.

import { fetchCreatorHolders } from './creator-holders.service';
import { prisma } from '../../utils/prisma.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      keyOwnership: {
         findMany: jest.fn(),
         count: jest.fn(),
         aggregate: jest.fn(),
      },
   },
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
   },
}));

const mockPrisma = prisma as unknown as {
   keyOwnership: {
      findMany: jest.Mock;
      count: jest.Mock;
      aggregate: jest.Mock;
   };
};

const CREATOR_ID = 'creator-cuid-tie-test';

interface FixtureRow {
   ownerAddress: string;
   balance: bigint;
   createdAt: Date;
}

// W2, W3, and W4 all share a balance of 15 — a three-way tie that spans the
// page-1/page-2 boundary when paging with limit=3.
const W1: FixtureRow = {
   ownerAddress: '0xAAAA000000000000000000000000000000AAAA',
   balance: BigInt(20),
   createdAt: new Date('2025-01-01T00:00:00Z'),
};
const W2: FixtureRow = {
   ownerAddress: '0xBBBB000000000000000000000000000000BBBB',
   balance: BigInt(15),
   createdAt: new Date('2025-01-02T00:00:00Z'),
};
const W3: FixtureRow = {
   ownerAddress: '0xCCCC000000000000000000000000000000CCCC',
   balance: BigInt(15),
   createdAt: new Date('2025-01-03T00:00:00Z'),
};
const W4: FixtureRow = {
   ownerAddress: '0xDDDD000000000000000000000000000000DDDD',
   balance: BigInt(15),
   createdAt: new Date('2025-01-04T00:00:00Z'),
};
const W5: FixtureRow = {
   ownerAddress: '0xEEEE000000000000000000000000000000EEEE',
   balance: BigInt(10),
   createdAt: new Date('2025-01-05T00:00:00Z'),
};

// Deliberately inserted out of final sort order to prove the mock (like the
// real DB) is the one doing the ordering, not incidental array order.
const ALL_ROWS: FixtureRow[] = [W3, W1, W5, W4, W2];

// The only correct order given ORDER BY balance DESC, ownerAddress ASC.
const EXPECTED_ORDER = [W1, W2, W3, W4, W5];

function installFindManyMock(): void {
   mockPrisma.keyOwnership.findMany.mockImplementation(
      async ({ skip = 0, take }: { skip?: number; take: number }) => {
         const sorted = [...ALL_ROWS].sort((a, b) => {
            if (a.balance !== b.balance) {
               return a.balance > b.balance ? -1 : 1;
            }
            return a.ownerAddress < b.ownerAddress ? -1 : 1;
         });
         return sorted.slice(skip, skip + take);
      }
   );
}

function makeQuery(limit: number, offset: number) {
   return { limit, offset, sort: 'key_balance' as const };
}

describe('fetchCreatorHolders – cursor pagination with tied holder counts', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      installFindManyMock();
      mockPrisma.keyOwnership.count.mockResolvedValue(ALL_ROWS.length);
      mockPrisma.keyOwnership.aggregate.mockResolvedValue({
         _sum: { balance: BigInt(75) },
      });
   });

   it('orders tied holders (same key count) alphabetically by wallet address', async () => {
      const [holders] = await fetchCreatorHolders(
         CREATOR_ID,
         makeQuery(5, 0)
      );

      expect(holders.map(h => h.wallet_address)).toEqual(
         EXPECTED_ORDER.map(r => r.ownerAddress)
      );

      // The three balance=15 holders (W2, W3, W4) must appear in ascending
      // wallet-address order, not insertion order.
      const tiedSlice = holders.slice(1, 4);
      expect(tiedSlice.map(h => h.wallet_address)).toEqual([
         W2.ownerAddress,
         W3.ownerAddress,
         W4.ownerAddress,
      ]);

      // Confirm the query itself requests the tie-breaking sort, not just
      // that the mock happens to return sorted data.
      expect(mockPrisma.keyOwnership.findMany).toHaveBeenCalledWith(
         expect.objectContaining({
            orderBy: [{ balance: 'desc' }, { ownerAddress: 'asc' }],
         })
      );
   });

   it('applying the page-1 cursor (offset) returns the remaining holders on page 2 with no duplicates', async () => {
      const [pageOne] = await fetchCreatorHolders(
         CREATOR_ID,
         makeQuery(3, 0)
      );
      const [pageTwo] = await fetchCreatorHolders(
         CREATOR_ID,
         makeQuery(3, pageOne.length)
      );

      const pageOneWallets = pageOne.map(h => h.wallet_address);
      const pageTwoWallets = pageTwo.map(h => h.wallet_address);

      // Tied group (W2, W3, W4) is split by the page boundary: W2 and W3
      // land on page 1, W4 spills onto page 2.
      expect(pageOneWallets).toEqual([
         W1.ownerAddress,
         W2.ownerAddress,
         W3.ownerAddress,
      ]);
      expect(pageTwoWallets).toEqual([W4.ownerAddress, W5.ownerAddress]);

      const overlap = pageOneWallets.filter(w => pageTwoWallets.includes(w));
      expect(overlap).toHaveLength(0);

      const combined = [...pageOneWallets, ...pageTwoWallets];
      expect(combined).toEqual(EXPECTED_ORDER.map(r => r.ownerAddress));
      expect(new Set(combined).size).toBe(EXPECTED_ORDER.length);
   });

   it('a cursor derived from a tied row produces a stable, repeatable next page', async () => {
      // The last row of page 1 (W3) is itself part of the tied group, so the
      // "cursor" for page 2 is derived from a tied row.
      const [pageOne] = await fetchCreatorHolders(
         CREATOR_ID,
         makeQuery(3, 0)
      );
      const lastRowOfPageOne = pageOne[pageOne.length - 1];
      expect(lastRowOfPageOne.wallet_address).toBe(W3.ownerAddress);

      const cursorOffset = pageOne.length;

      const [firstAttempt] = await fetchCreatorHolders(
         CREATOR_ID,
         makeQuery(3, cursorOffset)
      );
      const [secondAttempt] = await fetchCreatorHolders(
         CREATOR_ID,
         makeQuery(3, cursorOffset)
      );

      expect(firstAttempt.map(h => h.wallet_address)).toEqual(
         secondAttempt.map(h => h.wallet_address)
      );
      expect(firstAttempt.map(h => h.wallet_address)).toEqual([
         W4.ownerAddress,
         W5.ownerAddress,
      ]);
      expect(firstAttempt.map(h => h.rank)).toEqual(
         secondAttempt.map(h => h.rank)
      );
   });
});
