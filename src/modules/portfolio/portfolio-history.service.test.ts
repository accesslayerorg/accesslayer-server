// Unit tests: GET /portfolio/history (#1008)
// - point granularity per range (hourly for 7d, daily for 30d/90d, weekly for all)
// - value = holdings snapshot balance x price recorded at that instant
// - percentage return from first to last point
// - graceful empty response for wallets with no history
// - 5-minute Redis cache keyed per wallet per range

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      walletHoldingSnapshot: { findMany: jest.fn(), findFirst: jest.fn() },
      keyOwnership: { findMany: jest.fn(), findFirst: jest.fn() },
      creatorPriceHistory: { findMany: jest.fn(), findFirst: jest.fn() },
      creatorPriceSnapshot: { findMany: jest.fn() },
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(),
   cacheSetJson: jest.fn(),
}));

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import {
   computePortfolioHistory,
   getPortfolioHistory,
   portfolioHistoryCacheKey,
   PORTFOLIO_HISTORY_CACHE_TTL_SECONDS,
   PortfolioHistoryRange,
} from './portfolio-history.service';

const snapshotFindMany = prisma.walletHoldingSnapshot.findMany as jest.Mock;
const snapshotFindFirst = prisma.walletHoldingSnapshot.findFirst as jest.Mock;
const ownershipFindMany = prisma.keyOwnership.findMany as jest.Mock;
const ownershipFindFirst = prisma.keyOwnership.findFirst as jest.Mock;
const priceFindMany = prisma.creatorPriceHistory.findMany as jest.Mock;
const priceFindFirst = prisma.creatorPriceHistory.findFirst as jest.Mock;
const priceSnapshotFindMany = prisma.creatorPriceSnapshot
   .findMany as jest.Mock;

const mockCacheGet = cacheGetJson as jest.Mock;
const mockCacheSet = cacheSetJson as jest.Mock;

const WALLET = `G${'A'.repeat(55)}`;
const NOW = new Date('2026-10-16T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** stroops -> XLM per key. */
const xlm = (value: number) => BigInt(Math.round(value * 10_000_000));

interface SnapshotRow {
   creatorId: string;
   balance: number;
   recordedAt: Date;
}

interface PriceRow {
   creatorId: string;
   price: bigint;
   recordedAt: Date;
}

/**
 * Wires the prisma mocks as thin in-memory filters so the service's own
 * where/orderBy clauses decide what each query returns.
 */
function setupFixtures({
   snapshots = [],
   ownerships = [],
   prices = [],
   livePrices = [],
}: {
   snapshots?: SnapshotRow[];
   ownerships?: Array<{
      creatorId: string;
      balance: number;
      createdAt: Date;
   }>;
   prices?: PriceRow[];
   livePrices?: Array<{ creatorId: string; currentPrice: bigint }>;
}) {
   snapshotFindMany.mockImplementation(async (args: any) => {
      const { gte, lte } = args.where.recordedAt;
      return snapshots
         .filter(
            row => row.recordedAt >= gte && row.recordedAt <= lte
         )
         .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())
         .slice(0, args.take);
   });

   snapshotFindFirst.mockImplementation(async (args: any) => {
      // Serves two queries: the all-time window start (no creatorId filter)
      // and the per-creator baseline row before the window.
      if (args.where.recordedAt && 'lt' in args.where.recordedAt) {
         const match = snapshots
            .filter(
               row =>
                  row.creatorId === args.where.creatorId &&
                  row.recordedAt < args.where.recordedAt.lt
            )
            .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime());
         return match[0] ?? null;
      }
      const match = [...snapshots].sort(
         (a, b) => a.recordedAt.getTime() - b.recordedAt.getTime()
      );
      return match[0] ?? null;
   });

   ownershipFindMany.mockImplementation(async () => ownerships);
   ownershipFindFirst.mockImplementation(async () => {
      if (ownerships.length === 0) return null;
      return [...ownerships].sort(
         (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
      )[0];
   });

   priceFindMany.mockImplementation(async (args: any) => {
      const { gte, lte } = args.where.recordedAt;
      const ids: string[] = args.where.creatorId.in;
      return prices
         .filter(
            row =>
               ids.includes(row.creatorId) &&
               row.recordedAt >= gte &&
               row.recordedAt <= lte
         )
         .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime())
         .slice(0, args.take);
   });

   priceFindFirst.mockImplementation(async (args: any) => {
      const { lte } = args.where.recordedAt;
      const match = prices
         .filter(
            row =>
               row.creatorId === args.where.creatorId &&
               row.recordedAt <= lte
         )
         .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime());
      return match[0] ?? null;
   });

   priceSnapshotFindMany.mockImplementation(async (args: any) =>
      livePrices.filter(row =>
         args.where.creatorId.in.includes(row.creatorId)
      )
   );
}

function spacingMs(
   points: Array<{ timestamp: string }>
): number[] {
   return points.slice(1).map((point, index) =>
      Date.parse(point.timestamp) - Date.parse(points[index].timestamp)
   );
}

beforeEach(() => {
   jest.clearAllMocks();
   mockCacheGet.mockResolvedValue(null);
   setupFixtures({});
});

describe('portfolio history intervals', () => {
   const expectations: Array<{
      range: PortfolioHistoryRange;
      interval: string;
      intervalMs: number;
      pointCount: number;
   }> = [
      { range: '7d', interval: 'hourly', intervalMs: HOUR_MS, pointCount: 169 },
      { range: '30d', interval: 'daily', intervalMs: DAY_MS, pointCount: 31 },
      { range: '90d', interval: 'daily', intervalMs: DAY_MS, pointCount: 91 },
      {
         range: 'all',
         interval: 'weekly',
         intervalMs: 7 * DAY_MS,
         pointCount: 4,
      },
   ];

   it.each(expectations)(
      'returns $interval points for the $range range',
      async ({ range, interval, intervalMs, pointCount }) => {
         // Activity starts exactly 3 weeks ago so the 'all' range spans
         // 4 weekly points (now-21d, now-14d, now-7d, now).
         const firstActivity = new Date(NOW.getTime() - 21 * DAY_MS);
         setupFixtures({
            snapshots: [
               { creatorId: 'key-a', balance: 10, recordedAt: firstActivity },
            ],
            ownerships: [
               {
                  creatorId: 'key-a',
                  balance: 10,
                  createdAt: firstActivity,
               },
            ],
            prices: [
               {
                  creatorId: 'key-a',
                  price: xlm(2),
                  recordedAt: new Date(
                     NOW.getTime() - 40 * DAY_MS
                  ),
               },
            ],
         });

         const result = await computePortfolioHistory(WALLET, range, NOW);

         expect(result.interval).toBe(interval);
         expect(result.intervalMs).toBe(intervalMs);
         expect(result.points).toHaveLength(pointCount);
         // Every gap matches the range's granularity, ending at `now`.
         for (const gap of spacingMs(result.points)) {
            expect(gap).toBe(intervalMs);
         }
         expect(Date.parse(result.points[0].timestamp)).toBe(
            Date.parse(result.points[pointCount - 1].timestamp) -
               (pointCount - 1) * intervalMs
         );
         expect(Date.parse(result.points[pointCount - 1].timestamp)).toBe(
            NOW.getTime()
         );
      }
   );
});

describe('portfolio history values', () => {
   it('multiplies the holdings snapshot balance by the price at each interval', async () => {
      setupFixtures({
         snapshots: [
            {
               creatorId: 'key-a',
               balance: 10,
               recordedAt: new Date(NOW.getTime() - 40 * DAY_MS),
            },
         ],
         ownerships: [
            {
               creatorId: 'key-a',
               balance: 10,
               createdAt: new Date(NOW.getTime() - 40 * DAY_MS),
            },
         ],
         prices: [
            {
               creatorId: 'key-a',
               price: xlm(2),
               recordedAt: new Date(NOW.getTime() - 40 * DAY_MS),
            },
         ],
      });

      const result = await computePortfolioHistory(WALLET, '7d', NOW);

      expect(result.currency).toBe('XLM');
      expect(result.firstValue).toBe(20);
      expect(result.lastValue).toBe(20);
      // 10 keys x 2 XLM at every hourly point.
      expect(result.points.every(point => point.value === 20)).toBe(true);
      expect(result.percentageReturn).toBe(0);
   });

   it('carries the price recorded before the window into the earliest points', async () => {
      setupFixtures({
         ownerships: [
            {
               creatorId: 'key-a',
               balance: 10,
               createdAt: new Date(NOW.getTime() - 400 * DAY_MS),
            },
         ],
         // No price rows inside the 7-day window: only a pre-window one.
         prices: [
            {
               creatorId: 'key-a',
               price: xlm(1.5),
               recordedAt: new Date(NOW.getTime() - 400 * DAY_MS),
            },
         ],
      });

      const result = await computePortfolioHistory(WALLET, '7d', NOW);

      expect(result.points).toHaveLength(169);
      expect(result.points.every(point => point.value === 15)).toBe(true);
   });

   it('values each point with the price recorded at that instant', async () => {
      setupFixtures({
         snapshots: [
            {
               creatorId: 'key-a',
               balance: 10,
               recordedAt: new Date(NOW.getTime() - 40 * DAY_MS),
            },
         ],
         ownerships: [
            {
               creatorId: 'key-a',
               balance: 10,
               createdAt: new Date(NOW.getTime() - 40 * DAY_MS),
            },
         ],
         prices: [
            // Baseline price before the window, then a doubling 3 days ago.
            {
               creatorId: 'key-a',
               price: xlm(1),
               recordedAt: new Date(NOW.getTime() - 40 * DAY_MS),
            },
            {
               creatorId: 'key-a',
               price: xlm(2),
               recordedAt: new Date(NOW.getTime() - 3 * DAY_MS),
            },
         ],
      });

      const result = await computePortfolioHistory(WALLET, '7d', NOW);

      const priceChangeAt = NOW.getTime() - 3 * DAY_MS;
      const before = result.points.filter(
         point => Date.parse(point.timestamp) < priceChangeAt
      );
      const from = result.points.filter(
         point => Date.parse(point.timestamp) >= priceChangeAt
      );

      expect(before.length).toBeGreaterThan(0);
      expect(from.length).toBeGreaterThan(0);
      expect(before.every(point => point.value === 10)).toBe(true);
      expect(from.every(point => point.value === 20)).toBe(true);
      expect(result.firstValue).toBe(10);
      expect(result.lastValue).toBe(20);
      expect(result.percentageReturn).toBe(100);
   });

   it('replays holdings snapshots taken on each trade event', async () => {
      setupFixtures({
         snapshots: [
            // Sold half of the position 2 days ago.
            {
               creatorId: 'key-a',
               balance: 10,
               recordedAt: new Date(NOW.getTime() - 40 * DAY_MS),
            },
            {
               creatorId: 'key-a',
               balance: 5,
               recordedAt: new Date(NOW.getTime() - 2 * DAY_MS),
            },
         ],
         ownerships: [
            {
               creatorId: 'key-a',
               balance: 5,
               createdAt: new Date(NOW.getTime() - 40 * DAY_MS),
            },
         ],
         prices: [
            {
               creatorId: 'key-a',
               price: xlm(2),
               recordedAt: new Date(NOW.getTime() - 40 * DAY_MS),
            },
         ],
      });

      const result = await computePortfolioHistory(WALLET, '7d', NOW);

      const sellAt = NOW.getTime() - 2 * DAY_MS;
      const before = result.points.filter(
         point => Date.parse(point.timestamp) < sellAt
      );
      const from = result.points.filter(
         point => Date.parse(point.timestamp) >= sellAt
      );

      expect(before.every(point => point.value === 20)).toBe(true);
      expect(from.every(point => point.value === 10)).toBe(true);
      expect(result.percentageReturn).toBe(-50);
   });

   it('treats a position opened inside the window as zero before it existed', async () => {
      setupFixtures({
         ownerships: [
            {
               creatorId: 'key-a',
               balance: 10,
               createdAt: new Date(NOW.getTime() - 2 * DAY_MS),
            },
         ],
         prices: [
            {
               creatorId: 'key-a',
               price: xlm(2),
               recordedAt: new Date(NOW.getTime() - 400 * DAY_MS),
            },
         ],
      });

      const result = await computePortfolioHistory(WALLET, '7d', NOW);

      const buyAt = NOW.getTime() - 2 * DAY_MS;
      expect(
         result.points
            .filter(point => Date.parse(point.timestamp) < buyAt)
            .every(point => point.value === 0)
      ).toBe(true);
      expect(
         result.points
            .filter(point => Date.parse(point.timestamp) >= buyAt)
            .every(point => point.value === 20)
      ).toBe(true);
      // The series starts at zero, so there is no meaningful return.
      expect(result.firstValue).toBe(0);
      expect(result.lastValue).toBe(20);
      expect(result.percentageReturn).toBeNull();
   });

   it('aggregates value across every key the wallet holds', async () => {
      setupFixtures({
         snapshots: [
            {
               creatorId: 'key-a',
               balance: 10,
               recordedAt: new Date(NOW.getTime() - 40 * DAY_MS),
            },
            {
               creatorId: 'key-b',
               balance: 3,
               recordedAt: new Date(NOW.getTime() - 40 * DAY_MS),
            },
         ],
         ownerships: [
            {
               creatorId: 'key-a',
               balance: 10,
               createdAt: new Date(NOW.getTime() - 40 * DAY_MS),
            },
            {
               creatorId: 'key-b',
               balance: 3,
               createdAt: new Date(NOW.getTime() - 40 * DAY_MS),
            },
         ],
         prices: [
            {
               creatorId: 'key-a',
               price: xlm(2),
               recordedAt: new Date(NOW.getTime() - 40 * DAY_MS),
            },
            {
               creatorId: 'key-b',
               price: xlm(4),
               recordedAt: new Date(NOW.getTime() - 40 * DAY_MS),
            },
         ],
      });

      const result = await computePortfolioHistory(WALLET, '30d', NOW);

      // (10 x 2) + (3 x 4) = 32 XLM at every daily point.
      expect(result.points.every(point => point.value === 32)).toBe(true);
      expect(result.percentageReturn).toBe(0);
   });
});

describe('portfolio history with no history', () => {
   it('returns an empty series for a wallet that has never held a key', async () => {
      setupFixtures({});

      const result = await computePortfolioHistory(WALLET, '7d', NOW);

      expect(result).toMatchObject({
         wallet: WALLET,
         range: '7d',
         interval: 'hourly',
         intervalMs: HOUR_MS,
         currency: 'XLM',
         points: [],
         firstValue: 0,
         lastValue: 0,
         percentageReturn: null,
      });
   });

   it('returns an empty series for the all-time range when nothing is recorded', async () => {
      setupFixtures({});

      const result = await computePortfolioHistory(WALLET, 'all', NOW);

      expect(result.points).toEqual([]);
      expect(result.percentageReturn).toBeNull();
      expect(result.firstValue).toBe(0);
      expect(result.lastValue).toBe(0);
      // No recorded activity means there is no window to resolve.
      expect(ownershipFindMany).not.toHaveBeenCalled();
   });

   it('treats only-closed positions with no recorded history as no history', async () => {
      setupFixtures({
         ownerships: [
            {
               creatorId: 'key-a',
               balance: 0,
               createdAt: new Date(NOW.getTime() - 400 * DAY_MS),
            },
         ],
      });

      const result = await computePortfolioHistory(WALLET, '7d', NOW);

      expect(result.points).toEqual([]);
      expect(result.percentageReturn).toBeNull();
      // Nothing to value means no price lookups either.
      expect(priceFindMany).not.toHaveBeenCalled();
   });

   it('charts a position that was fully sold inside the window down to zero', async () => {
      setupFixtures({
         snapshots: [
            {
               creatorId: 'key-a',
               balance: 10,
               recordedAt: new Date(NOW.getTime() - 40 * DAY_MS),
            },
            {
               creatorId: 'key-a',
               balance: 0,
               recordedAt: new Date(NOW.getTime() - 2 * DAY_MS),
            },
         ],
         ownerships: [
            {
               creatorId: 'key-a',
               balance: 0,
               createdAt: new Date(NOW.getTime() - 40 * DAY_MS),
            },
         ],
         prices: [
            {
               creatorId: 'key-a',
               price: xlm(2),
               recordedAt: new Date(NOW.getTime() - 40 * DAY_MS),
            },
         ],
      });

      const result = await computePortfolioHistory(WALLET, '7d', NOW);

      const soldAt = NOW.getTime() - 2 * DAY_MS;
      expect(
         result.points
            .filter(point => Date.parse(point.timestamp) < soldAt)
            .every(point => point.value === 20)
      ).toBe(true);
      expect(
         result.points
            .filter(point => Date.parse(point.timestamp) >= soldAt)
            .every(point => point.value === 0)
      ).toBe(true);
      expect(result.firstValue).toBe(20);
      expect(result.lastValue).toBe(0);
      expect(result.percentageReturn).toBe(-100);
   });
});

describe('portfolio history caching', () => {
   it('builds a cache key per wallet per range', () => {
      expect(portfolioHistoryCacheKey(WALLET, '30d')).toBe(
         `portfolio:history:v1:${WALLET}:30d`
      );
      expect(portfolioHistoryCacheKey(WALLET, '7d')).not.toBe(
         portfolioHistoryCacheKey(WALLET, '30d')
      );
   });

   it('serves the cached series without touching the database', async () => {
      mockCacheGet.mockResolvedValue({
         wallet: WALLET,
         range: '7d',
         points: [{ timestamp: NOW.toISOString(), value: 42 }],
      });

      const result = await getPortfolioHistory(WALLET, '7d', NOW);

      expect(result.points).toEqual([
         { timestamp: NOW.toISOString(), value: 42 },
      ]);
      expect(snapshotFindMany).not.toHaveBeenCalled();
      expect(mockCacheSet).not.toHaveBeenCalled();
   });

   it('caches a computed series for 5 minutes under the wallet+range key', async () => {
      mockCacheGet.mockResolvedValue(null);
      setupFixtures({
         ownerships: [
            {
               creatorId: 'key-a',
               balance: 10,
               createdAt: new Date(NOW.getTime() - 40 * DAY_MS),
            },
         ],
         prices: [
            {
               creatorId: 'key-a',
               price: xlm(2),
               recordedAt: new Date(NOW.getTime() - 40 * DAY_MS),
            },
         ],
      });

      const result = await getPortfolioHistory(WALLET, '90d', NOW);

      expect(result.lastValue).toBe(20);
      expect(mockCacheSet).toHaveBeenCalledWith(
         `portfolio:history:v1:${WALLET}:90d`,
         result,
         300
      );
      expect(PORTFOLIO_HISTORY_CACHE_TTL_SECONDS).toBe(300);
   });
});
