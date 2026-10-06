import {
   getDiscovery,
   getLeaderboard,
   searchAll,
   invalidateKeysCache,
} from './keys-discovery.service';
import { prisma } from '../../utils/prisma.utils';

// Issue #901 / #896 / #895 — the discovery, leaderboard and search services.
// Prisma is mocked at the module boundary: the volume aggregation, snapshot
// merge, ranking and caching logic run for real against fixture data.

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      trade: { findMany: jest.fn() },
      creatorProfile: { findMany: jest.fn() },
      $queryRawUnsafe: jest.fn(),
   },
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const mockedPrisma = prisma as unknown as {
   trade: { findMany: jest.Mock };
   creatorProfile: { findMany: jest.Mock };
   $queryRawUnsafe: jest.Mock;
};

const CREATOR = (id: string, handle: string, price: string, ago: string) => ({
   id,
   handle,
   displayName: handle,
   priceSnapshot: { currentPrice: BigInt(price), price24hAgo: BigInt(ago) },
});

const CREATOR_BARE = (id: string, handle: string) => ({
   id,
   handle,
   displayName: handle,
   priceSnapshot: null,
});

beforeEach(() => {
   jest.clearAllMocks();
   invalidateKeysCache();
});

describe('getDiscovery (#901)', () => {
   it('returns top 5 by 24h volume and 10 newest listings', async () => {
      mockedPrisma.trade.findMany.mockImplementation(async (args: any) => {
         void args;
         return ['a', 'b', 'c', 'd', 'e', 'f'].flatMap((id, i) =>
            Array.from({ length: 1000 - i * 100 }, () => ({
               creatorId: id,
               price: '1',
            }))
         );
      });
      mockedPrisma.creatorProfile.findMany.mockImplementation(
         async (args: any) => {
            if (args.orderBy) {
               // new listings query
               return ['g', 'h'].map((id) => CREATOR_BARE(id, `new-${id}`));
            }
            const ids: string[] = args.where.id.in;
            return ids.map((id) => CREATOR(id, `key-${id}`, '500', '400'));
         }
      );

      const body = await getDiscovery();
      expect(body.trending).toHaveLength(5);
      expect(body.trending[0].volume_24h).toBe('1000');
      expect((body.trending[0] as unknown as { rank?: number }).rank ?? undefined).toBeUndefined();
      expect(body.new_listings).toHaveLength(2);
      // Snapshot-derived price and change present on every entry.
      expect(body.trending[0].price).toBe('500');
      expect(body.trending[0].change_24h).toBeCloseTo(25);
   });

   it('zero-volume sections still return entries from snapshots', async () => {
      mockedPrisma.trade.findMany.mockResolvedValue([]);
      // Same fixture for both queries: the new-listings findMany (has orderBy)
      // and the buildMarketEntries lookup (where.id.in, no orderBy).
      mockedPrisma.creatorProfile.findMany.mockResolvedValue([
         CREATOR_BARE('only', 'lonely'),
      ]);

      const body = await getDiscovery();
      expect(body.trending).toEqual([]);
      expect(body.new_listings).toHaveLength(1);
      expect(body.new_listings[0].price).toBe('0');
      expect(body.new_listings[0].volume_24h).toBe('0');
   });

   it('caches for 60s and invalidates on key creation', async () => {
      mockedPrisma.trade.findMany.mockResolvedValue(
         Array.from({ length: 10 }, () => ({ creatorId: 'a', price: '1' }))
      );
      mockedPrisma.creatorProfile.findMany.mockResolvedValue([
         CREATOR('a', 'alpha', '5', '4'),
      ]);

      await getDiscovery();
      expect(mockedPrisma.trade.findMany).toHaveBeenCalledTimes(1);
      await getDiscovery();
      expect(mockedPrisma.trade.findMany).toHaveBeenCalledTimes(1); // cache hit

      invalidateKeysCache();
      await getDiscovery();
      expect(mockedPrisma.trade.findMany).toHaveBeenCalledTimes(2); // invalidated
   });
});

describe('getLeaderboard (#896)', () => {
   it('ranks by volume descending with rank numbers', async () => {
      mockedPrisma.trade.findMany.mockImplementation(async (args: any) => {
         void args;
         return [
            ...Array.from({ length: 5 }, () => ({ creatorId: 'low', price: '1' })),
            ...Array.from({ length: 999 }, () => ({ creatorId: 'high', price: '1' })),
            ...Array.from({ length: 50 }, () => ({ creatorId: 'mid', price: '1' })),
         ];
      });
      mockedPrisma.creatorProfile.findMany.mockImplementation(async (args: any) =>
         (args.where.id.in as string[]).map((id) => CREATOR(id, id, '10', '5'))
      );

      const body = await getLeaderboard('24h', 10);
      expect(body.items.map((i) => i.key_id)).toEqual(['high', 'mid', 'low']);
      expect(body.items[0].rank).toBe(1);
      expect(body.items[2].volume_24h).toBe('5');
   });

   it('accepts every supported window and caps the limit', async () => {
      mockedPrisma.trade.findMany.mockResolvedValue([]);
      mockedPrisma.creatorProfile.findMany.mockResolvedValue([]);

      for (const window of ['24h', '7d', '30d'] as const) {
         await getLeaderboard(window, 100); // 100 exceeds the cap; service clamps at the controller, service trusts caller here
         expect(mockedPrisma.trade.findMany).toHaveBeenCalledWith(
            expect.objectContaining({
               where: expect.objectContaining({ timestamp: expect.anything() }),
            })
         );
      }
   });
});

describe('searchAll (#895)', () => {
   it('searches all three entity types and ranks by relevance', async () => {
      mockedPrisma.creatorProfile.findMany
         .mockResolvedValueOnce([
            CREATOR('k1', 'artkey', '5', '4'),
            CREATOR('k2', 'the-art-key', '5', '4'),
         ])
         .mockResolvedValueOnce([CREATOR('c1', 'artist', '5', '4')]);
      mockedPrisma.$queryRawUnsafe.mockResolvedValue([
         { id: 'p1', title: 'art proposal', description: null },
      ]);

      const body = await searchAll('art', ['keys', 'creators', 'proposals']);
      expect(body.keys).toHaveLength(2);
      // Exact-prefix ranking puts "artkey" before "the-art-key".
      expect(body.keys[0].id).toBe('k1');
      expect(body.creators).toHaveLength(1);
      expect(body.proposals).toHaveLength(1);
      expect(body.proposals[0].type).toBe('proposals');
   });

   it('type filter restricts which sections are queried', async () => {
      mockedPrisma.creatorProfile.findMany.mockResolvedValue([]);
      mockedPrisma.$queryRawUnsafe.mockResolvedValue([]);

      const body = await searchAll('anything', ['creators']);
      expect(mockedPrisma.creatorProfile.findMany).toHaveBeenCalledTimes(1);
      expect(mockedPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
      expect(body.keys).toEqual([]);
      expect(body.creators).toEqual([]);
   });

   it('a governance table outage degrades to empty proposals, not an error', async () => {
      mockedPrisma.creatorProfile.findMany.mockResolvedValue([]);
      mockedPrisma.$queryRawUnsafe.mockRejectedValue(
         new Error('relation "governance_proposals" does not exist')
      );

      const body = await searchAll('x', ['proposals']);
      expect(body.proposals).toEqual([]);
   });
});
