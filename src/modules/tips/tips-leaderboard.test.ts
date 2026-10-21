import express from 'express';
import request from 'supertest';
import tipsRouter from './tips.routes';
import { getTipLeaderboard, invalidateKeyTipsCache } from './tips.service';
import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheInvalidate,
   cacheSetJson,
} from '../../utils/redis.utils';

const mockCacheStore = new Map<string, string>();
const mockTtls: number[] = [];

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) => {
      const raw = mockCacheStore.get(key);
      return raw === undefined ? null : JSON.parse(raw);
   }),
   cacheSetJson: jest.fn(
      async (key: string, value: unknown, ttlSeconds: number) => {
         mockCacheStore.set(key, JSON.stringify(value));
         mockTtls.push(ttlSeconds);
      }
   ),
   cacheInvalidate: jest.fn(async (pattern: string) => {
      const prefix = pattern.replace(/\*$/, '');
      for (const k of Array.from(mockCacheStore.keys())) {
         if (k.startsWith(prefix)) {
            mockCacheStore.delete(k);
         }
      }
   }),
}));

jest.mock('../whitelist/whitelist.service', () => ({
   resolveCreatorId: jest.fn(async (keyId: string) => keyId),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      keyTip: {
         findMany: jest.fn(),
      },
   },
}));

const app = express();
app.use(express.json());
app.use('/keys', tipsRouter);

const WALLET_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const WALLET_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF';

beforeEach(() => {
   jest.clearAllMocks();
   mockCacheStore.clear();
   mockTtls.length = 0;
});

describe('GET /keys/:key_id/tips/leaderboard (#1173)', () => {
   it('returns tippers ranked by total amount with truncated wallets', async () => {
      (prisma.keyTip.findMany as jest.Mock).mockResolvedValue([
         { tipper: WALLET_B, amount: '10.0000000', anonymous: false },
         { tipper: WALLET_A, amount: '25.5000000', anonymous: false },
         { tipper: WALLET_A, amount: '14.5000000', anonymous: false },
      ]);

      const res = await request(app).get(
         '/keys/key-1/tips/leaderboard?limit=5'
      );

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual([
         {
            rank: 1,
            wallet: 'GAAA…AWHF',
            total_tipped: '40.0000000',
            tip_count: 2,
            anonymous: false,
         },
         {
            rank: 2,
            wallet: 'GBBB…BWHF',
            total_tipped: '10.0000000',
            tip_count: 1,
            anonymous: false,
         },
      ]);
      expect(cacheSetJson).toHaveBeenCalledWith(
         'key:tips:key-1:leaderboard:5',
         expect.any(Array),
         300
      );
   });

   it('handles anonymous tips with wallet: null and anonymous: true', async () => {
      (prisma.keyTip.findMany as jest.Mock).mockResolvedValue([
         { tipper: 'anonymous', amount: '50.0000000', anonymous: true },
         { tipper: WALLET_A, amount: '20.0000000', anonymous: false },
      ]);

      const leaderboard = await getTipLeaderboard('key-1', 10);

      expect(leaderboard).toEqual([
         {
            rank: 1,
            wallet: null,
            total_tipped: '50.0000000',
            tip_count: 1,
            anonymous: true,
         },
         {
            rank: 2,
            wallet: 'GAAA…AWHF',
            total_tipped: '20.0000000',
            tip_count: 1,
            anonymous: false,
         },
      ]);
   });

   it('returns an empty list for keys with no tips', async () => {
      (prisma.keyTip.findMany as jest.Mock).mockResolvedValue([]);

      const res = await request(app).get('/keys/key-empty/tips/leaderboard');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
   });

   it('serves cached responses in under 200ms and invalidates on new TipSent event', async () => {
      (prisma.keyTip.findMany as jest.Mock).mockResolvedValue([
         { tipper: WALLET_A, amount: '15.0000000', anonymous: false },
      ]);

      await request(app).get('/keys/key-1/tips/leaderboard?limit=10');
      const start = Date.now();
      const cachedRes = await request(app).get(
         '/keys/key-1/tips/leaderboard?limit=10'
      );
      const elapsed = Date.now() - start;

      expect(cachedRes.status).toBe(200);
      expect(elapsed).toBeLessThan(200);
      expect(prisma.keyTip.findMany).toHaveBeenCalledTimes(1);
      expect(cacheGetJson).toHaveBeenCalledTimes(2);

      await invalidateKeyTipsCache('key-1');
      expect(cacheInvalidate).toHaveBeenCalledWith('key:tips:key-1:*');

      await request(app).get('/keys/key-1/tips/leaderboard?limit=10');
      expect(prisma.keyTip.findMany).toHaveBeenCalledTimes(2);
   });
});
