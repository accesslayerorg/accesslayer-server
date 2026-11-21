// src/modules/keys/key-holder-leaderboard.integration.test.ts
// Acceptance tests for #1013: holder leaderboard + wallet rank lookup.
import supertest from 'supertest';
import app from '../../app';
import {
   getHolderLeaderboard,
   getHolderRank,
   onHolderBalanceChanged,
   holderLeaderboardCacheKey,
   HOLDER_LEADERBOARD_CACHE_TTL_SECONDS,
} from './key-holder-leaderboard.service';

// ── In-memory fake of the Prisma calls the service makes ────────────────────
interface Row {
   ownerAddress: string;
   creatorId: string;
   balance: number;
   createdAt: Date;
}
const mockDb: { rows: Row[]; supply: number } = { rows: [], supply: 0 };

function mockMatch(row: any, where: any): boolean {
   return Object.entries(where).every(([field, cond]: [string, any]) => {
      if (field === 'OR') return cond.some((w: any) => mockMatch(row, w));
      const v = row[field];
      // Prisma Decimal filters accept numeric strings; coerce like the DB does.
      const cmp = (x: any) =>
         x instanceof Date ? x.getTime() : field === 'balance' ? Number(x) : x;
      if (cond instanceof Date) return v.getTime() === cond.getTime();
      if (cond !== null && typeof cond === 'object') {
         if ('gt' in cond && !(cmp(v) > cmp(cond.gt))) return false;
         if ('lt' in cond && !(cmp(v) < cmp(cond.lt))) return false;
         return true;
      }
      return cmp(v) === cmp(cond);
   });
}
function mockSort(rows: Row[], orderBy: any[]): Row[] {
   return [...rows].sort((a: any, b: any) => {
      for (const o of orderBy) {
         const [f, dir] = Object.entries(o)[0] as [string, string];
         const x = a[f] instanceof Date ? a[f].getTime() : a[f];
         const y = b[f] instanceof Date ? b[f].getTime() : b[f];
         if (x === y) continue;
         return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
      }
      return 0;
   });
}

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findFirst: jest.fn(async ({ where }: any) => {
            const ids = where.OR.flatMap((o: any) => Object.values(o));
            return ids.includes('key-1')
               ? { id: 'key-1', circulatingSupply: mockDb.supply }
               : null;
         }),
      },
      keyOwnership: {
         findMany: jest.fn(async ({ where, orderBy, take }: any) =>
            mockSort(
               mockDb.rows.filter(r => mockMatch(r, where)),
               orderBy
            ).slice(0, take)
         ),
         count: jest.fn(
            async ({ where }: any) =>
               mockDb.rows.filter(r => mockMatch(r, where)).length
         ),
         aggregate: jest.fn(async ({ where }: any) => ({
            _sum: {
               balance: mockDb.rows
                  .filter(r => mockMatch(r, where))
                  .reduce((s, r) => s + r.balance, 0),
            },
         })),
         findUnique: jest.fn(async ({ where }: any) => {
            const k = where.ownerAddress_creatorId;
            return (
               mockDb.rows.find(
                  r =>
                     r.ownerAddress === k.ownerAddress &&
                     r.creatorId === k.creatorId
               ) ?? null
            );
         }),
      },
      $disconnect: jest.fn(),
   },
}));

// ── In-memory fake of the Redis cache helpers ────────────────────────────────
const mockCache = new Map<string, { value: string; ttl: number }>();
const mockCacheSet = jest.fn();
jest.mock('../../utils/redis.utils', () => ({
   getRedis: jest.fn(() => null),
   cacheGetJson: jest.fn(async (key: string) => {
      const hit = mockCache.get(key);
      return hit ? JSON.parse(hit.value) : null;
   }),
   cacheSetJson: jest.fn(async (key: string, value: unknown, ttl: number) => {
      mockCacheSet(key, ttl);
      mockCache.set(key, { value: JSON.stringify(value), ttl });
   }),
   cacheInvalidate: jest.fn(async (...keys: string[]) => {
      keys.forEach(k => mockCache.delete(k));
   }),
}));

// Valid Stellar-format test wallets (G + 55 base32 chars); sorts by n.
const addr = (n: number) =>
   'G' +
   String.fromCharCode(65 + Math.floor(n / 26)) +
   String.fromCharCode(65 + (n % 26)) +
   'A'.repeat(53);
const day = (d: number) => new Date(Date.UTC(2026, 0, d));
const holder = (n: number, balance: number, d = n): Row => ({
   ownerAddress: addr(n),
   creatorId: 'key-1',
   balance,
   createdAt: day(d),
});

beforeEach(() => {
   mockCache.clear();
   mockCacheSet.mockClear();
   mockDb.supply = 1000;
   mockDb.rows = [
      holder(1, 100),
      holder(2, 500),
      holder(3, 250),
      holder(4, 0), // sold everything: excluded
      { ...holder(5, 150), creatorId: 'other-key' }, // other key: excluded
   ];
});

describe('GET /api/v1/keys/:keyId/holders/leaderboard', () => {
   it('ranks holders by balance descending with supply % and since date', async () => {
      const res = await supertest(app).get(
         '/api/v1/keys/key-1/holders/leaderboard'
      );

      expect(res.status).toBe(200);
      const { items, totalHolders } = res.body.data;
      expect(totalHolders).toBe(3);
      expect(items.map((i: any) => [i.rank, i.wallet_address, i.balance])).toEqual([
         [1, addr(2), 500],
         [2, addr(3), 250],
         [3, addr(1), 100],
      ]);
      expect(items[0].since).toBe(day(2).toISOString());
   });

   it('computes supply percentage per holder', async () => {
      const res = await supertest(app).get(
         '/api/v1/keys/key-1/holders/leaderboard'
      );
      expect(res.body.data.items.map((i: any) => i.supply_percent)).toEqual([
         50, 25, 10,
      ]);
   });

   it('falls back to the sum of balances when circulating supply is unset', async () => {
      mockDb.supply = 0;
      const page = await getHolderLeaderboard('key-1');
      expect(page.totalSupply).toBe(850);
      expect(page.items[0].supply_percent).toBeCloseTo((500 / 850) * 100);
   });

   it('breaks balance ties deterministically (earlier holder, then wallet)', async () => {
      mockDb.rows = [
         holder(7, 100, 5),
         holder(8, 100, 3),
         holder(6, 100, 3),
      ];
      const page = await getHolderLeaderboard('key-1');
      expect(page.items.map(i => i.wallet_address)).toEqual([
         addr(6),
         addr(8),
         addr(7),
      ]);
      // Rank lookup must agree with the list for tied holders.
      for (const item of page.items) {
         const r = await getHolderRank('key-1', item.wallet_address);
         expect(r.rank).toBe(item.rank);
      }
   });

   it('returns 404 for an unknown key and 400 for a bad limit', async () => {
      expect(
         (await supertest(app).get('/api/v1/keys/nope/holders/leaderboard'))
            .status
      ).toBe(404);
      expect(
         (
            await supertest(app).get(
               '/api/v1/keys/key-1/holders/leaderboard?limit=101'
            )
         ).status
      ).toBe(400);
   });

   it('paginates beyond the top 100 with a cursor, without gaps or duplicates', async () => {
      mockDb.rows = Array.from({ length: 130 }, (_, i) =>
         holder(i + 1, 1000 - i, 1 + (i % 28))
      );

      const first = await getHolderLeaderboard('key-1');
      expect(first.items).toHaveLength(100);
      expect(first.hasMore).toBe(true);
      expect(first.totalHolders).toBe(130);
      expect(first.nextCursor).toEqual(expect.any(String));

      const second = await getHolderLeaderboard('key-1', {
         cursor: first.nextCursor!,
      });
      expect(second.items).toHaveLength(30);
      expect(second.hasMore).toBe(false);
      expect(second.nextCursor).toBeNull();
      expect(second.items[0].rank).toBe(101);
      expect(second.items[29].rank).toBe(130);

      const all = [...first.items, ...second.items];
      expect(new Set(all.map(i => i.wallet_address)).size).toBe(130);
      expect(all.map(i => i.balance)).toEqual(
         [...all.map(i => i.balance)].sort((a, b) => b - a)
      );
   });

   it('keeps cursor pages stable when balances change between requests', async () => {
      mockDb.rows = Array.from({ length: 6 }, (_, i) => holder(i + 1, 600 - i * 100));
      const p1 = await getHolderLeaderboard('key-1', { limit: 2 });
      expect(p1.items.map(i => i.balance)).toEqual([600, 500]);

      // The top holder sells down below everyone; rows ahead of the cursor
      // changing must not cause skipped or duplicated holders on page 2.
      mockDb.rows[0].balance = 50;
      const p2 = await getHolderLeaderboard('key-1', {
         limit: 2,
         cursor: p1.nextCursor!,
      });
      expect(p2.items.map(i => i.balance)).toEqual([400, 300]);
      expect(p2.items[0].rank).toBe(2); // only the 600->50 holder left the head
   });

   it('rejects a tampered cursor with 400', async () => {
      const res = await supertest(app).get(
         '/api/v1/keys/key-1/holders/leaderboard?cursor=garbage.deadbeef'
      );
      expect(res.status).toBe(400);
   });
});

describe('GET /api/v1/keys/:keyId/holders/:wallet/rank', () => {
   it('returns the correct rank and balance for a holder', async () => {
      const res = await supertest(app).get(
         `/api/v1/keys/key-1/holders/${addr(3)}/rank`
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
         keyId: 'key-1',
         wallet_address: addr(3),
         rank: 2,
         balance: 250,
         supply_percent: 25,
         totalHolders: 3,
      });
   });

   it('returns 404 for a wallet with no balance, 400 for a malformed wallet', async () => {
      expect(
         (await supertest(app).get(`/api/v1/keys/key-1/holders/${addr(4)}/rank`))
            .status
      ).toBe(404);
      expect(
         (await supertest(app).get('/api/v1/keys/key-1/holders/not-a-wallet/rank'))
            .status
      ).toBe(400);
   });
});

describe('recompute and cache behaviour', () => {
   it('serves repeated reads from cache with a 5-minute TTL', async () => {
      await getHolderLeaderboard('key-1');
      expect(mockCacheSet).toHaveBeenCalledWith(
         holderLeaderboardCacheKey('key-1'),
         HOLDER_LEADERBOARD_CACHE_TTL_SECONDS
      );
      expect(HOLDER_LEADERBOARD_CACHE_TTL_SECONDS).toBe(300);

      mockDb.rows[1].balance = 1; // DB changes, no event fired
      const cached = await getHolderLeaderboard('key-1');
      expect(cached.items[0].balance).toBe(500); // still the cached snapshot
      expect(mockCacheSet).toHaveBeenCalledTimes(1);
   });

   it('recomputes the leaderboard after a trade or transfer event', async () => {
      const before = await getHolderLeaderboard('key-1');
      expect(before.items[0].wallet_address).toBe(addr(2));

      // addr(1) buys 900 more keys; the indexer/transfer path fires the hook.
      mockDb.rows[0].balance = 1000;
      await onHolderBalanceChanged('key-1');

      const after = await getHolderLeaderboard('key-1');
      expect(after.items.map(i => [i.rank, i.wallet_address, i.balance])).toEqual([
         [1, addr(1), 1000],
         [2, addr(2), 500],
         [3, addr(3), 250],
      ]);
      expect((await getHolderRank('key-1', addr(1))).rank).toBe(1);
   });

   it('never throws from the event hook when the refresh fails', async () => {
      await expect(onHolderBalanceChanged('missing-key')).resolves.toBeUndefined();
   });
});
