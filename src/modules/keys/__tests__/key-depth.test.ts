const redisStore = new Map<string, string>();

jest.mock('../../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) => {
      const v = redisStore.get(key);
      return v ? JSON.parse(v) : null;
   }),
   cacheSetJson: jest.fn(async (key: string, value: unknown) => {
      redisStore.set(key, JSON.stringify(value));
   }),
   cacheInvalidate: jest.fn(async (...patterns: string[]) => {
      for (const pattern of patterns) {
         const prefix = pattern.replace(/\*$/, '');
         for (const k of [...redisStore.keys()]) {
            if (k.startsWith(prefix)) redisStore.delete(k);
         }
      }
   }),
}));

jest.mock('../../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: { findFirst: jest.fn() },
      keyDepth: {
         findMany: jest.fn(),
         findFirst: jest.fn(),
         updateMany: jest.fn(),
         create: jest.fn(),
      },
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
import { processDepthUpdatedEvent } from '../../indexer/key-depth-indexer.service';

const db = prisma as any;
const app = express();
app.use('/api/v1/keys', keysRouter);

type Level = { price: bigint; volume: bigint };
const BIDS: Level[] = [
   { price: 100n, volume: 10n },
   { price: 99n, volume: 20n },
   { price: 98n, volume: 30n },
];
const ASKS: Level[] = [
   { price: 105n, volume: 5n },
   { price: 106n, volume: 15n },
];

function mockBook(bids: Level[], asks: Level[]) {
   db.keyDepth.findMany.mockImplementation(
      async ({ where, take }: { where: { side: string }; take: number }) =>
         (where.side === 'bid' ? bids : asks).slice(0, take)
   );
   db.keyDepth.findFirst.mockImplementation(
      async ({ where }: { where: { side: string } }) =>
         (where.side === 'bid' ? bids : asks)[0] ?? null
   );
}

beforeEach(() => {
   jest.clearAllMocks();
   redisStore.clear();
   db.creatorProfile.findFirst.mockResolvedValue({ id: 'key-1' });
   mockBook(BIDS, ASKS);
});

describe('GET /keys/:keyId/depth', () => {
   it('returns top N levels with cumulative volumes', async () => {
      const res = await request(app).get('/api/v1/keys/key-1/depth?levels=2');

      expect(res.status).toBe(200);
      expect(res.body.data.bids).toEqual([
         { price: '100', volume: '10', cumulative_volume: '10' },
         { price: '99', volume: '20', cumulative_volume: '30' },
      ]);
      expect(res.body.data.asks).toEqual([
         { price: '105', volume: '5', cumulative_volume: '5' },
         { price: '106', volume: '15', cumulative_volume: '20' },
      ]);
   });

   it('defaults to 10 levels', async () => {
      await request(app).get('/api/v1/keys/key-1/depth');
      expect(db.keyDepth.findMany).toHaveBeenCalledWith(
         expect.objectContaining({ take: 10 })
      );
   });

   it('returns empty depth for a key with no open orders', async () => {
      mockBook([], []);
      const res = await request(app).get('/api/v1/keys/key-1/depth');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ bids: [], asks: [] });
   });

   it.each(['0', '101', 'abc', '1.5'])(
      'rejects levels=%s with 422',
      async levels => {
         const res = await request(app).get(
            `/api/v1/keys/key-1/depth?levels=${levels}`
         );
         expect(res.status).toBe(422);
      }
   );

   it('returns 404 for an unknown key', async () => {
      db.creatorProfile.findFirst.mockResolvedValue(null);
      const res = await request(app).get('/api/v1/keys/nope/depth');
      expect(res.status).toBe(404);
   });

   it('serves from cache until a DepthUpdated event invalidates it', async () => {
      await request(app).get('/api/v1/keys/key-1/depth?levels=2');
      await request(app).get('/api/v1/keys/key-1/depth?levels=2');
      expect(db.keyDepth.findMany).toHaveBeenCalledTimes(2); // bids + asks, once

      db.keyDepth.updateMany.mockResolvedValue({ count: 1 });
      await processDepthUpdatedEvent({
         txHash: 'tx-9',
         eventIndex: 0,
         eventType: 'DEPTH_UPDATED',
         ledger: 2000,
         creatorId: 'key-1',
         side: 'bid',
         price: '100',
         volume: '99',
      });

      await request(app).get('/api/v1/keys/key-1/depth?levels=2');
      expect(db.keyDepth.findMany).toHaveBeenCalledTimes(4);
   });
});

describe('GET /keys/:keyId/depth/spread', () => {
   it('returns best bid, best ask, spread and mid-price', async () => {
      const res = await request(app).get('/api/v1/keys/key-1/depth/spread');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
         best_bid: '100',
         best_ask: '105',
         mid_price: '102.5',
         spread: '5',
      });
   });

   it('returns an integer mid-price when the sum is even', async () => {
      mockBook([{ price: 100n, volume: 1n }], [{ price: 110n, volume: 1n }]);
      const res = await request(app).get('/api/v1/keys/key-1/depth/spread');
      expect(res.body.data.mid_price).toBe('105');
   });

   it('returns nulls when a side is empty', async () => {
      mockBook(BIDS, []);
      const res = await request(app).get('/api/v1/keys/key-1/depth/spread');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
         best_bid: '100',
         best_ask: null,
         mid_price: null,
         spread: null,
      });
   });

   it('returns 404 for an unknown key', async () => {
      db.creatorProfile.findFirst.mockResolvedValue(null);
      const res = await request(app).get('/api/v1/keys/nope/depth/spread');
      expect(res.status).toBe(404);
   });
});
