// src/modules/search/search.service.test.ts
jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      $queryRaw: jest.fn(),
      contractTransaction: { findUnique: jest.fn() },
      trade: { findFirst: jest.fn() },
   },
}));

import { prisma } from '../../utils/prisma.utils';
import { decodeCursor, encodeCursor } from '../../utils/cursor.utils';
import {
   getGroupedSearch,
   InvalidSearchCursorError,
   searchCreators,
   searchKeys,
   searchTransaction,
   SearchQueryTooShortError,
   type CreatorSearchCursor,
   type KeySearchCursor,
} from './search.service';

const mockQueryRaw = prisma.$queryRaw as unknown as jest.Mock;
const mockContractFindUnique = prisma.contractTransaction
   .findUnique as unknown as jest.Mock;
const mockTradeFindFirst = prisma.trade.findFirst as unknown as jest.Mock;

function keyRow(overrides: Record<string, unknown> = {}) {
   return {
      keyId: 'key-1',
      keyAddress: 'CKEY1',
      name: 'Alice Art',
      symbol: 'ALICE',
      description: 'Digital art from Alice',
      imageUrl: null,
      creatorName: 'Alice',
      creatorHandle: 'alice',
      creatorAvatarUrl: null,
      currentPrice: 1000n,
      holderCount: 3,
      deprecatedAt: null,
      priority: 2,
      ...overrides,
   };
}

function creatorRow(overrides: Record<string, unknown> = {}) {
   return {
      id: 'creator-1',
      handle: 'alice',
      displayName: 'Alice',
      bio: 'Artist',
      avatarUrl: null,
      isVerified: true,
      walletAddress: 'GALICE123',
      followersCount: 7,
      priority: 2,
      ...overrides,
   };
}

/** Returns the SQL text from a Prisma `$queryRaw` tagged-template call. */
function sqlOf(call: unknown[]): string {
   return (call[0] as string[]).join('');
}

/** Returns the interpolated values from a Prisma `$queryRaw` call. */
function valuesOf(call: unknown[]): unknown[] {
   return call.slice(1);
}

beforeEach(() => {
   jest.clearAllMocks();
});

describe('searchKeys', () => {
   it('matches name, symbol and description', async () => {
      mockQueryRaw.mockResolvedValue([keyRow()]);

      const page = await searchKeys('ali', { limit: 20 });

      expect(page.items).toHaveLength(1);
      expect(page.hasMore).toBe(false);
      expect(page.nextCursor).toBeNull();

      const call = mockQueryRaw.mock.calls[0];
      const sql = sqlOf(call);
      expect(sql).toContain('km."name" ILIKE');
      expect(sql).toContain('km."symbol" ILIKE');
      expect(sql).toContain('km."description" ILIKE');
      // Raw SQL must use the mapped column name for imageUrl.
      expect(sql).toContain('km."image_url" AS "imageUrl"');
      expect(valuesOf(call)).toContain('%ali%');
   });

   it('maps rows to the public key result shape', async () => {
      mockQueryRaw.mockResolvedValue([
         keyRow({
            currentPrice: 2500n,
            holderCount: 4n,
            deprecatedAt: new Date('2026-01-01T00:00:00.000Z'),
         }),
      ]);

      const [item] = (await searchKeys('alice', { limit: 10 })).items;

      expect(item).toEqual({
         keyId: 'key-1',
         keyAddress: 'CKEY1',
         name: 'Alice Art',
         symbol: 'ALICE',
         description: 'Digital art from Alice',
         imageUrl: null,
         creatorName: 'Alice',
         creatorHandle: 'alice',
         creatorAvatarUrl: null,
         currentPrice: '2500',
         holderCount: 4,
         deprecated: true,
      });
   });

   it('over-fetches by one and returns a keyset cursor for the next page', async () => {
      mockQueryRaw.mockResolvedValue([
         keyRow({ keyId: 'key-1', name: 'A key', priority: 2 }),
         keyRow({ keyId: 'key-2', name: 'B key', priority: 2 }),
         keyRow({ keyId: 'key-3', name: 'C key', priority: 2 }),
      ]);

      const page = await searchKeys('key', { limit: 2 });

      expect(page.items.map(i => i.keyId)).toEqual(['key-1', 'key-2']);
      expect(page.hasMore).toBe(true);
      expect(page.limit).toBe(2);

      const cursor = decodeCursor<KeySearchCursor>(page.nextCursor!);
      expect(cursor).toEqual({ priority: 2, name: 'B key', keyId: 'key-2' });
   });

   it('applies the decoded cursor to the next query', async () => {
      mockQueryRaw.mockResolvedValue([]);
      const cursor = encodeCursor({
         priority: 2,
         name: 'B key',
         keyId: 'key-2',
      });

      await searchKeys('key', { limit: 2, cursor });

      const call = mockQueryRaw.mock.calls[0];
      const sql = sqlOf(call);
      expect(sql).toContain('(priority, "name", "keyId") >');
      const values = valuesOf(call) as unknown[];
      expect(values).toEqual(expect.arrayContaining([2, 'B key', 'key-2']));
   });

   it('rejects a tampered cursor', async () => {
      await expect(
         searchKeys('key', { limit: 2, cursor: 'not-a-cursor' })
      ).rejects.toBeInstanceOf(InvalidSearchCursorError);
      expect(mockQueryRaw).not.toHaveBeenCalled();
   });

   it('rejects queries shorter than the minimum length', async () => {
      await expect(searchKeys('a', { limit: 10 })).rejects.toBeInstanceOf(
         SearchQueryTooShortError
      );
      await expect(searchKeys('  ', { limit: 10 })).rejects.toBeInstanceOf(
         SearchQueryTooShortError
      );
      expect(mockQueryRaw).not.toHaveBeenCalled();
   });
});

describe('searchCreators', () => {
   it('matches display name and wallet-address prefix', async () => {
      mockQueryRaw.mockResolvedValue([creatorRow()]);

      const page = await searchCreators('ali', { limit: 20 });

      expect(page.items).toEqual([
         {
            id: 'creator-1',
            handle: 'alice',
            displayName: 'Alice',
            bio: 'Artist',
            avatarUrl: null,
            isVerified: true,
            walletAddress: 'GALICE123',
            followersCount: 7,
         },
      ]);

      const call = mockQueryRaw.mock.calls[0];
      const sql = sqlOf(call);
      expect(sql).toContain('c."displayName" ILIKE');
      expect(sql).toContain('w."address" ILIKE');
      // Address matching is prefix-based: only the prefix pattern is used for
      // the wallet clause, never a leading-wildcard pattern.
      const values = valuesOf(call);
      expect(values).toContain('%ali%');
      expect(values).toContain('ali%');
      expect(values).not.toContain('%ali');
   });

   it('paginates creators with a keyset cursor', async () => {
      mockQueryRaw.mockResolvedValue([
         creatorRow({ id: 'c1', displayName: 'A' }),
         creatorRow({ id: 'c2', displayName: 'B' }),
      ]);

      const page = await searchCreators('al', { limit: 1 });

      expect(page.items.map(i => i.id)).toEqual(['c1']);
      expect(page.hasMore).toBe(true);
      const cursor = decodeCursor<CreatorSearchCursor>(page.nextCursor!);
      expect(cursor).toEqual({ priority: 2, displayName: 'A', id: 'c1' });
   });
});

describe('searchTransaction', () => {
   it('returns an exact contract transaction match', async () => {
      mockContractFindUnique.mockResolvedValue({
         txHash: 'abc123',
         operation: 'buy',
         status: 'CONFIRMED',
         submitterWallet: 'GWALLET',
         ledger: 42,
         createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      const result = await searchTransaction('abc123');

      expect(mockContractFindUnique).toHaveBeenCalledWith(
         expect.objectContaining({ where: { txHash: 'abc123' } })
      );
      expect(result).toEqual({
         txHash: 'abc123',
         source: 'contract',
         operation: 'buy',
         status: 'CONFIRMED',
         creatorId: null,
         wallet: 'GWALLET',
         ledger: 42,
         timestamp: '2026-01-01T00:00:00.000Z',
      });
   });

   it('falls back to an exact indexed trade match', async () => {
      mockContractFindUnique.mockResolvedValue(null);
      mockTradeFindFirst.mockResolvedValue({
         txHash: 'def456',
         creatorId: 'creator-1',
         buyer: 'GBUYER',
         ledger: 43,
         timestamp: new Date('2026-01-02T00:00:00.000Z'),
      });

      const result = await searchTransaction('def456');

      expect(mockTradeFindFirst).toHaveBeenCalledWith(
         expect.objectContaining({ where: { txHash: 'def456' } })
      );
      expect(result).toEqual(
         expect.objectContaining({
            txHash: 'def456',
            source: 'trade',
            operation: 'trade',
            creatorId: 'creator-1',
            wallet: 'GBUYER',
         })
      );
   });

   it('does not prefix-match tx hashes', async () => {
      mockContractFindUnique.mockResolvedValue(null);
      mockTradeFindFirst.mockResolvedValue(null);

      const result = await searchTransaction('abc');

      expect(result).toBeNull();
      expect(mockContractFindUnique).toHaveBeenCalledWith(
         expect.objectContaining({ where: { txHash: 'abc' } })
      );
      expect(mockTradeFindFirst).toHaveBeenCalledWith(
         expect.objectContaining({ where: { txHash: 'abc' } })
      );
   });
});

describe('getGroupedSearch', () => {
   it('returns top 3 keys, top 3 creators and top 1 transaction', async () => {
      const keyRows = [0, 1, 2, 3].map(i =>
         keyRow({ keyId: `key-${i}`, name: `Key ${i}` })
      );
      const creatorRows = [0, 1, 2, 3].map(i =>
         creatorRow({ id: `creator-${i}`, displayName: `Creator ${i}` })
      );
      mockQueryRaw
         .mockResolvedValueOnce(keyRows)
         .mockResolvedValueOnce(creatorRows);
      mockContractFindUnique.mockResolvedValue({
         txHash: 'abc123',
         operation: 'sell',
         status: 'CONFIRMED',
         submitterWallet: 'GWALLET',
         ledger: 42,
         createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      const result = await getGroupedSearch('  key  ');

      expect(result.query).toBe('key');
      expect(result.keys).toHaveLength(3);
      expect(result.creators).toHaveLength(3);
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].txHash).toBe('abc123');
   });

   it('returns empty groups when nothing matches', async () => {
      mockQueryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      mockContractFindUnique.mockResolvedValue(null);
      mockTradeFindFirst.mockResolvedValue(null);

      const result = await getGroupedSearch('zzzz');

      expect(result).toEqual({
         query: 'zzzz',
         keys: [],
         creators: [],
         transactions: [],
      });
   });
});
