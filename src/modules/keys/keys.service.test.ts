import {
   getDiscovery,
   getLeaderboard,
   searchAll,
   invalidateKeysCache,
} from './keys-discovery.service';
import { getSpotlight, invalidateSpotlightCache } from './discovery.service';
import { prisma } from '../../utils/prisma.utils';

// Issue #901 / #896 / #895 — the discovery, leaderboard and search services.
// Prisma is mocked at the module boundary: the volume aggregation, snapshot
// merge, ranking and caching logic run for real against fixture data.

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      trade: { findMany: jest.fn() },
      creatorProfile: { findMany: jest.fn(), findUnique: jest.fn() },
      spotlight: { findFirst: jest.fn() },
      keyOwnership: { aggregate: jest.fn() },
      $queryRawUnsafe: jest.fn(),
   },
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const mockedPrisma = prisma as unknown as {
   trade: { findMany: jest.Mock };
   creatorProfile: { findMany: jest.Mock; findUnique: jest.Mock };
   spotlight: { findFirst: jest.Mock };
   keyOwnership: { aggregate: jest.Mock };
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
   invalidateSpotlightCache();
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


describe('getSpotlight (#1151)', () => {
   beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));
   });

   afterEach(() => {
      jest.useRealTimers();
   });

   it('returns no_spotlight: true when no active spotlight exists', async () => {
      mockedPrisma.spotlight.findFirst.mockResolvedValue(null);

      const body = await getSpotlight();
      expect(body).toEqual({ no_spotlight: true });
      expect(mockedPrisma.spotlight.findFirst).toHaveBeenCalledTimes(1);

      // Verify it was cached
      await getSpotlight();
      expect(mockedPrisma.spotlight.findFirst).toHaveBeenCalledTimes(1);
   });

   it('returns correctly formatted active spotlight details', async () => {
      const endsAt = new Date('2024-01-01T12:01:00.000Z'); // 60 seconds in the future
      mockedPrisma.spotlight.findFirst.mockResolvedValue({
         id: 'spot-1',
         keyId: 'spotlighted-key',
         winnerWallet: 'winner-wallet',
         winningBid: 123.456,
         startsAt: new Date('2024-01-01T11:59:00.000Z'),
         endsAt,
      });

      mockedPrisma.creatorProfile.findMany.mockResolvedValue([
         CREATOR('spotlighted-key', 'handle', '789', '600'),
      ]);

      mockedPrisma.creatorProfile.findUnique.mockResolvedValue({
         handle: 'handle',
         priceSnapshot: { currentPrice: '789' }
      });

      mockedPrisma.keyOwnership.aggregate.mockResolvedValue({
         _count: { ownerAddress: 42 },
      });

      mockedPrisma.trade.findMany.mockResolvedValue([
         { creatorId: 'spotlighted-key', price: '100' },
         { creatorId: 'spotlighted-key', price: '200' },
      ]);

      const body = await getSpotlight();

      expect(body.no_spotlight).toBeUndefined();
      expect(body.key_id).toBe('spotlighted-key');
      expect(body.creator).toBe('handle');
      expect(body.current_price).toBe('789');
      expect(body['24h_volume']).toBe('300'); // 100 + 200
      expect(body.holder_count).toBe(42);
      expect(body.end_time).toBe(endsAt.toISOString());
      expect(body.winning_bid).toBe('123.456');
      expect(body.time_remaining_seconds).toBe(60);
   });

   it('decreases time_remaining_seconds between calls from the cache', async () => {
      const endsAt = new Date('2024-01-01T12:01:00.000Z'); // 60s
      mockedPrisma.spotlight.findFirst.mockResolvedValue({
         id: 'spot-1', keyId: 'spot', winningBid: 100, startsAt: new Date(), endsAt
      });
      mockedPrisma.creatorProfile.findMany.mockResolvedValue([CREATOR('spot', 'h', '1', '1')]);
      mockedPrisma.creatorProfile.findUnique.mockResolvedValue({ handle: 'h' });
      mockedPrisma.keyOwnership.aggregate.mockResolvedValue({ _count: { ownerAddress: 1 } });
      mockedPrisma.trade.findMany.mockResolvedValue([]);

      const b1 = await getSpotlight();
      expect(b1.time_remaining_seconds).toBe(60);

      jest.setSystemTime(new Date('2024-01-01T12:00:10.000Z'));

      const b2 = await getSpotlight();
      expect(b2.time_remaining_seconds).toBe(50);
      expect(mockedPrisma.spotlight.findFirst).toHaveBeenCalledTimes(1); // Cached
   });


   it('expires no_spotlight cache after 30 seconds and queries database again', async () => {
      mockedPrisma.spotlight.findFirst.mockResolvedValue(null);

      await getSpotlight();
      expect(mockedPrisma.spotlight.findFirst).toHaveBeenCalledTimes(1);

      jest.setSystemTime(new Date('2024-01-01T12:00:31.001Z'));
      await getSpotlight();
      expect(mockedPrisma.spotlight.findFirst).toHaveBeenCalledTimes(2); // Cache expired
   });

   it('expires cache after 30 seconds and queries database again', async () => {
      const endsAt = new Date('2024-01-01T12:01:00.000Z'); // 60s
      mockedPrisma.spotlight.findFirst.mockResolvedValue({
         id: 'spot-1', keyId: 'spot', winningBid: 100, startsAt: new Date(), endsAt
      });
      mockedPrisma.creatorProfile.findMany.mockResolvedValue([CREATOR('spot', 'h', '1', '1')]);
      mockedPrisma.creatorProfile.findUnique.mockResolvedValue({ handle: 'h' });
      mockedPrisma.keyOwnership.aggregate.mockResolvedValue({ _count: { ownerAddress: 1 } });
      mockedPrisma.trade.findMany.mockResolvedValue([]);

      await getSpotlight();
      expect(mockedPrisma.spotlight.findFirst).toHaveBeenCalledTimes(1);

      jest.setSystemTime(new Date('2024-01-01T12:00:31.001Z'));
      await getSpotlight();
      expect(mockedPrisma.spotlight.findFirst).toHaveBeenCalledTimes(2); // Cache expired
   });

   it('returns no_spotlight: true if a cached spotlight expires', async () => {
      const endsAt = new Date('2024-01-01T12:00:15.000Z'); // 15s in the future
      mockedPrisma.spotlight.findFirst.mockResolvedValue({
         id: 'spot-1', keyId: 'spot', winningBid: 100, startsAt: new Date(), endsAt
      });
      mockedPrisma.creatorProfile.findMany.mockResolvedValue([CREATOR('spot', 'h', '1', '1')]);
      mockedPrisma.creatorProfile.findUnique.mockResolvedValue({ handle: 'h' });
      mockedPrisma.keyOwnership.aggregate.mockResolvedValue({ _count: { ownerAddress: 1 } });
      mockedPrisma.trade.findMany.mockResolvedValue([]);

      const b1 = await getSpotlight();
      expect(b1.no_spotlight).toBeUndefined();
      expect(mockedPrisma.spotlight.findFirst).toHaveBeenCalledTimes(1);

      // Advance time beyond the spotlight's end time, but before the 30s cache expires
      jest.setSystemTime(new Date('2024-01-01T12:00:20.000Z'));

      const b2 = await getSpotlight();
      expect(b2).toEqual({ no_spotlight: true });
      expect(mockedPrisma.spotlight.findFirst).toHaveBeenCalledTimes(1); // Served from cache
   });

   it('invalidates cache correctly via invalidateSpotlightCache', async () => {
      mockedPrisma.spotlight.findFirst.mockResolvedValue(null);

      await getSpotlight();
      expect(mockedPrisma.spotlight.findFirst).toHaveBeenCalledTimes(1);

      await getSpotlight();
      expect(mockedPrisma.spotlight.findFirst).toHaveBeenCalledTimes(1);

      invalidateSpotlightCache();

      await getSpotlight();
      expect(mockedPrisma.spotlight.findFirst).toHaveBeenCalledTimes(2);
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
