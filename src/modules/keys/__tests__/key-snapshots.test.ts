// GET /api/v1/keys/:keyId/snapshots (#1112): route, read service and cache
// invalidation wired end to end against an in-memory Redis and mocked Prisma.

const redisStore = new Map<string, string>();

jest.mock('../../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) => {
      const v = redisStore.get(key);
      return v ? JSON.parse(v) : null;
   }),
   cacheSetJson: jest.fn(async (key: string, value: unknown) => {
      redisStore.set(key, JSON.stringify(value));
   }),
   cacheInvalidate: jest.fn(async (...keys: string[]) => {
      for (const k of keys) redisStore.delete(k);
   }),
}));

jest.mock('../../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: { findFirst: jest.fn(), findUnique: jest.fn() },
      keyAnalyticsSnapshot: { findMany: jest.fn() },
      $executeRaw: jest.fn(),
   },
}));

jest.mock('../../../utils/indexer-dlq.utils', () => ({
   moveToDLQ: jest.fn().mockResolvedValue({}),
}));

jest.mock('../../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      isLevelEnabled: jest.fn().mockReturnValue(false),
   },
}));

import request from 'supertest';
import express from 'express';
import keysRouter from '../keys.routes';
import { prisma } from '../../../utils/prisma.utils';
import { cacheSetJson } from '../../../utils/redis.utils';
import { processSnapshotTakenEvent } from '../../indexer/key-snapshot-indexer.service';
import { rangeStartDate } from '../key-snapshots.service';

const app = express();
app.use(express.json());
app.use('/api/v1/keys', keysRouter);

const db = prisma as any;
const KEYS: Record<string, string> = { 'key-1': 'key-1', alice: 'key-1' };

function row(date: string, overrides: Record<string, unknown> = {}) {
   return {
      snapshotDate: new Date(`${date}T00:00:00.000Z`),
      price: 12500000n,
      volume: 980000000n,
      holderCount: 42,
      marketCap: 525000000n,
      ...overrides,
   };
}

beforeEach(() => {
   jest.clearAllMocks();
   redisStore.clear();
   db.creatorProfile.findFirst.mockImplementation(async (args: any) => {
      const term = args.where.OR[0].id;
      const id = KEYS[term];
      return id ? { id } : null;
   });
   db.keyAnalyticsSnapshot.findMany.mockResolvedValue([]);
   db.$executeRaw.mockResolvedValue(1);
});

describe('rangeStartDate', () => {
   const now = new Date('2026-10-27T08:00:00.000Z');

   it.each([
      ['7d', '2026-10-21'],
      ['30d', '2026-09-28'],
      ['90d', '2026-07-30'],
   ] as const)('%s starts %s (today counted)', (range, expected) => {
      expect(rangeStartDate(range, now)?.toISOString().slice(0, 10)).toBe(
         expected
      );
   });

   it('all is unbounded', () => {
      expect(rangeStartDate('all', now)).toBeNull();
   });
});

describe('GET /api/v1/keys/:keyId/snapshots', () => {
   it('returns daily snapshots with all four metrics, oldest first', async () => {
      db.keyAnalyticsSnapshot.findMany.mockResolvedValue([
         row('2026-10-25'),
         row('2026-10-26', { price: 13000000n, holderCount: 45 }),
      ]);

      const res = await request(app).get(
         '/api/v1/keys/key-1/snapshots?range=7d'
      );

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
         {
            date: '2026-10-25',
            price: '12500000',
            volume: '980000000',
            holder_count: 42,
            market_cap: '525000000',
         },
         {
            date: '2026-10-26',
            price: '13000000',
            volume: '980000000',
            holder_count: 45,
            market_cap: '525000000',
         },
      ]);
      const args = db.keyAnalyticsSnapshot.findMany.mock.calls[0][0];
      expect(args.orderBy).toEqual({ snapshotDate: 'asc' });
   });

   it.each(['7d', '30d', '90d'])(
      'filters %s from the current date backward',
      async range => {
         await request(app).get(`/api/v1/keys/key-1/snapshots?range=${range}`);
         const args = db.keyAnalyticsSnapshot.findMany.mock.calls[0][0];
         expect(args.where.creatorId).toBe('key-1');
         expect(args.where.snapshotDate.gte).toBeInstanceOf(Date);
      }
   );

   it('range=all applies no date filter', async () => {
      await request(app).get('/api/v1/keys/key-1/snapshots?range=all');
      const args = db.keyAnalyticsSnapshot.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ creatorId: 'key-1' });
   });

   it('defaults to 30d when range is omitted', async () => {
      await request(app).get('/api/v1/keys/key-1/snapshots');
      expect(cacheSetJson).toHaveBeenCalledWith(
         'key-snapshots:key-1:30d',
         [],
         300
      );
   });

   it('returns an empty array for a key with no snapshots yet', async () => {
      const res = await request(app).get(
         '/api/v1/keys/key-1/snapshots?range=all'
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
   });

   it('resolves a handle to the canonical key id', async () => {
      await request(app).get('/api/v1/keys/alice/snapshots?range=7d');
      const args = db.keyAnalyticsSnapshot.findMany.mock.calls[0][0];
      expect(args.where.creatorId).toBe('key-1');
   });

   it('returns 404 for an unknown key', async () => {
      const res = await request(app).get('/api/v1/keys/nope/snapshots');
      expect(res.status).toBe(404);
   });

   it('returns 422 for an unsupported range', async () => {
      const res = await request(app).get(
         '/api/v1/keys/key-1/snapshots?range=1y'
      );
      expect(res.status).toBe(422);
      expect(db.keyAnalyticsSnapshot.findMany).not.toHaveBeenCalled();
   });

   it('caches for 5 minutes and serves repeat requests from cache under 200ms', async () => {
      db.keyAnalyticsSnapshot.findMany.mockResolvedValue([row('2026-10-26')]);
      await request(app).get('/api/v1/keys/key-1/snapshots?range=7d');
      expect(cacheSetJson).toHaveBeenCalledWith(
         'key-snapshots:key-1:7d',
         expect.any(Array),
         300
      );

      const started = Date.now();
      const res = await request(app).get(
         '/api/v1/keys/key-1/snapshots?range=7d'
      );
      const elapsed = Date.now() - started;

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(db.keyAnalyticsSnapshot.findMany).toHaveBeenCalledTimes(1);
      expect(elapsed).toBeLessThan(200);
   });

   it('a new SnapshotTaken event invalidates every cached range for the key', async () => {
      db.keyAnalyticsSnapshot.findMany.mockResolvedValue([row('2026-10-25')]);
      for (const range of ['7d', '30d', '90d', 'all']) {
         await request(app).get(`/api/v1/keys/key-1/snapshots?range=${range}`);
      }
      expect(redisStore.size).toBe(4);

      await processSnapshotTakenEvent({
         txHash: 'tx-9',
         eventIndex: 0,
         eventType: 'SnapshotTaken',
         ledger: 9000,
         creatorId: 'key-1',
         price: '14000000',
         volume: '1000',
         holder_count: 50,
         market_cap: '700000000',
         timestamp: '2026-10-26T23:59:00.000Z',
      });
      expect(redisStore.size).toBe(0);

      db.keyAnalyticsSnapshot.findMany.mockResolvedValue([
         row('2026-10-25'),
         row('2026-10-26', { price: 14000000n }),
      ]);
      const res = await request(app).get(
         '/api/v1/keys/key-1/snapshots?range=7d'
      );
      expect(res.body.data).toHaveLength(2);
      expect(res.body.data[1].price).toBe('14000000');
   });
});
