const prismaMock: any = {
   dutchAuction: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
   },
   indexedLedger: { findFirst: jest.fn() },
};

jest.mock('../../utils/prisma.utils', () => ({ prisma: prismaMock }));

const cache = new Map<string, string>();
const cacheGetJson = jest.fn(async (key: string) => {
   const raw = cache.get(key);
   return raw ? JSON.parse(raw) : null;
});
const cacheSetJson = jest.fn(
   async (key: string, value: unknown, _ttl?: number) => {
      cache.set(key, JSON.stringify(value));
   }
);
jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: (key: string) => cacheGetJson(key),
   cacheSetJson: (key: string, value: unknown, ttl: number) =>
      cacheSetJson(key, value, ttl),
}));

const horizonGet = jest.fn();
jest.mock('../../clients/horizon.client', () => ({
   horizonGet: (...args: unknown[]) => horizonGet(...args),
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
   },
}));

import express from 'express';
import supertest from 'supertest';
import dutchAuctionRouter from './dutch-auction.routes';
import {
   effectiveStatus,
   markEndedAuctions,
   nextPriceChangeAt,
   toQuote,
} from './dutch-auction.service';
import { DUTCH_AUCTION_LIST_CACHE_TTL_SECONDS } from './dutch-auction.constants';

const CLOSED_AT = '2026-11-22T10:00:00.000Z';

function mockLedger(ledger: number) {
   horizonGet.mockResolvedValue({
      ok: true,
      json: async () => ({
         core_latest_ledger: ledger,
         history_latest_ledger_closed_at: CLOSED_AT,
      }),
   });
}

function row(overrides: Record<string, unknown> = {}) {
   return {
      id: 'a1',
      seller: 'GSELLER',
      keyId: 'key-1',
      quantity: 10,
      remaining: 10,
      startPrice: '100.0000000',
      floorPrice: '10.0000000',
      startLedger: 1000,
      durationLedgers: 100,
      status: 'open',
      fillCount: 0,
      createdAt: new Date('2026-11-22T09:00:00Z'),
      updatedAt: new Date('2026-11-22T09:00:00Z'),
      ...overrides,
   };
}

describe('Dutch auction quotes', () => {
   let app: express.Express;

   beforeEach(() => {
      jest.clearAllMocks();
      cache.clear();
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      jest.setSystemTime(new Date('2026-11-22T10:00:01.000Z'));
      prismaMock.dutchAuction.findMany.mockResolvedValue([]);
      prismaMock.dutchAuction.updateMany.mockResolvedValue({ count: 0 });
      app = express();
      app.use('/auctions', dutchAuctionRouter);
   });

   afterEach(() => jest.useRealTimers());

   describe('GET /auctions/:id', () => {
      it('returns the start price at the start ledger', async () => {
         mockLedger(1000);
         prismaMock.dutchAuction.findUnique.mockResolvedValue(row());

         const res = await supertest(app).get('/auctions/a1');

         expect(res.status).toBe(200);
         expect(res.body.data).toMatchObject({
            id: 'a1',
            currentPrice: '100',
            startPrice: '100',
            floorPrice: '10',
            status: 'open',
            quotedAtLedger: 1000,
            endLedger: 1100,
         });
      });

      it('returns an interpolated price and the next price change time', async () => {
         mockLedger(1050);
         prismaMock.dutchAuction.findUnique.mockResolvedValue(row());

         const res = await supertest(app).get('/auctions/a1');

         expect(res.body.data.currentPrice).toBe('55');
         // Ledger closed at 10:00:00, next one is expected 5s later.
         expect(res.body.data.nextPriceChangeAt).toBe(
            '2026-11-22T10:00:05.000Z'
         );
      });

      it('returns the floor price at and after the duration', async () => {
         for (const ledger of [1100, 1500]) {
            mockLedger(ledger);
            prismaMock.dutchAuction.findUnique.mockResolvedValue(
               row({ fillCount: 1, remaining: 5 })
            );
            const res = await supertest(app).get('/auctions/a1');
            expect(res.body.data.currentPrice).toBe('10');
            // A partially filled auction stays open at the floor; the price
            // no longer changes.
            expect(res.body.data.status).toBe('open');
            expect(res.body.data.nextPriceChangeAt).toBeNull();
         }
      });

      it('reports an unfilled auction past its duration as ended and persists it', async () => {
         mockLedger(1100);
         prismaMock.dutchAuction.findUnique.mockResolvedValue(row());
         prismaMock.dutchAuction.findMany.mockResolvedValueOnce([
            { id: 'a1', startLedger: 1000, durationLedgers: 100 },
         ]);

         const res = await supertest(app).get('/auctions/a1');

         expect(res.body.data.status).toBe('ended');
         expect(res.body.data.nextPriceChangeAt).toBeNull();
         expect(prismaMock.dutchAuction.updateMany).toHaveBeenCalledWith({
            where: { id: { in: ['a1'] }, status: 'open', fillCount: 0 },
            data: { status: 'ended' },
         });
      });

      it('keeps a partially filled auction open with its reduced remaining quantity', async () => {
         mockLedger(1050);
         prismaMock.dutchAuction.findUnique.mockResolvedValue(
            row({ remaining: 6, fillCount: 1 })
         );
         const res = await supertest(app).get('/auctions/a1');
         expect(res.body.data).toMatchObject({ remaining: 6, status: 'open' });
      });

      it('returns 404 for an unknown auction', async () => {
         mockLedger(1000);
         prismaMock.dutchAuction.findUnique.mockResolvedValue(null);
         const res = await supertest(app).get('/auctions/nope');
         expect(res.status).toBe(404);
      });

      it('falls back to the indexed ledger when Horizon is unavailable', async () => {
         horizonGet.mockRejectedValue(new Error('down'));
         prismaMock.indexedLedger.findFirst.mockResolvedValue({
            ledger: 1050,
            updatedAt: new Date(CLOSED_AT),
         });
         prismaMock.dutchAuction.findUnique.mockResolvedValue(row());

         const res = await supertest(app).get('/auctions/a1');

         expect(res.status).toBe(200);
         expect(res.body.data.currentPrice).toBe('55');
      });
   });

   describe('GET /auctions', () => {
      it('lists only open auctions by default, so cancelled ones are excluded', async () => {
         mockLedger(1050);
         prismaMock.dutchAuction.findMany.mockResolvedValue([row()]);

         const res = await supertest(app).get('/auctions?keyId=key-1');

         expect(res.status).toBe(200);
         const listCall = prismaMock.dutchAuction.findMany.mock.calls.find(
            ([args]: any[]) => args.take
         )[0];
         expect(listCall.where).toMatchObject({
            status: 'open',
            keyId: 'key-1',
         });
         expect(res.body.data.items).toHaveLength(1);
         expect(res.body.data.items[0].currentPrice).toBe('55');
      });

      it('filters by an explicit status', async () => {
         mockLedger(1050);
         await supertest(app).get('/auctions?status=cancelled');
         const listCall = prismaMock.dutchAuction.findMany.mock.calls.find(
            ([args]: any[]) => args.take
         )[0];
         expect(listCall.where.status).toBe('cancelled');
      });

      it('rejects an unknown status', async () => {
         const res = await supertest(app).get('/auctions?status=bogus');
         expect(res.status).toBe(400);
      });

      it('rejects a tampered cursor', async () => {
         mockLedger(1050);
         const res = await supertest(app).get('/auctions?cursor=abc.def');
         expect(res.status).toBe(400);
      });

      it('paginates with a cursor that resumes after the last item', async () => {
         mockLedger(1050);
         const rows = [
            row({ id: 'a3', startLedger: 1030 }),
            row({ id: 'a2', startLedger: 1020 }),
            row({ id: 'a1', startLedger: 1010 }),
         ];
         prismaMock.dutchAuction.findMany.mockResolvedValue(rows);

         const first = await supertest(app).get('/auctions?limit=2');

         expect(first.body.data.items.map((i: any) => i.id)).toEqual([
            'a3',
            'a2',
         ]);
         expect(first.body.data.hasMore).toBe(true);
         const cursor = first.body.data.nextCursor;
         expect(cursor).toEqual(expect.any(String));

         cache.clear();
         prismaMock.dutchAuction.findMany.mockResolvedValue([rows[2]]);
         const second = await supertest(app).get(
            `/auctions?limit=2&cursor=${cursor}`
         );

         const call = prismaMock.dutchAuction.findMany.mock.calls
            .filter(([args]: any[]) => args.take)
            .pop()[0];
         expect(call.where.OR).toEqual([
            { startLedger: { lt: 1020 } },
            { startLedger: 1020, id: { lt: 'a2' } },
         ]);
         expect(second.body.data.items.map((i: any) => i.id)).toEqual(['a1']);
         expect(second.body.data.nextCursor).toBeNull();
      });

      it('caches the listing for 5 seconds', async () => {
         mockLedger(1050);
         prismaMock.dutchAuction.findMany.mockResolvedValue([row()]);

         const first = await supertest(app).get('/auctions?keyId=key-1');
         const callsAfterFirst =
            prismaMock.dutchAuction.findMany.mock.calls.length;
         const second = await supertest(app).get('/auctions?keyId=key-1');

         expect(DUTCH_AUCTION_LIST_CACHE_TTL_SECONDS).toBe(5);
         expect(cacheSetJson).toHaveBeenCalledTimes(1);
         expect(cacheSetJson).toHaveBeenCalledWith(
            expect.stringContaining('dutch-auctions:list:key-1:open'),
            expect.any(Object),
            5
         );
         // Second request is served from cache: no further queries.
         expect(prismaMock.dutchAuction.findMany.mock.calls.length).toBe(
            callsAfterFirst
         );
         expect(second.body).toEqual(first.body);
      });

      it('keeps separate cache entries per filter', async () => {
         mockLedger(1050);
         await supertest(app).get('/auctions?keyId=key-1');
         await supertest(app).get('/auctions?keyId=key-2');
         await supertest(app).get('/auctions?keyId=key-1&status=ended');
         expect(cacheSetJson).toHaveBeenCalledTimes(3);
      });
   });

   describe('helpers', () => {
      it('marks nothing when no open auction has run out', async () => {
         prismaMock.dutchAuction.findMany.mockResolvedValue([
            { id: 'a1', startLedger: 1000, durationLedgers: 100 },
         ]);
         expect(await markEndedAuctions(1099)).toBe(0);
         expect(prismaMock.dutchAuction.updateMany).not.toHaveBeenCalled();
      });

      it('derives status without touching the database', () => {
         const base = {
            status: 'open',
            fillCount: 0,
            startLedger: 1000,
            durationLedgers: 100,
         };
         expect(effectiveStatus(base, 1099)).toBe('open');
         expect(effectiveStatus(base, 1100)).toBe('ended');
         expect(effectiveStatus({ ...base, fillCount: 2 }, 1100)).toBe('open');
         expect(effectiveStatus({ ...base, status: 'cancelled' }, 1100)).toBe(
            'cancelled'
         );
         expect(effectiveStatus({ ...base, status: 'filled' }, 1100)).toBe(
            'filled'
         );
      });

      it('never reports a next price change in the past', () => {
         const clock = {
            ledger: 1050,
            closedAt: new Date('2026-11-22T09:00:00Z'),
         };
         const result = nextPriceChangeAt(row() as any, 'open', clock);
         expect(new Date(result as string).getTime()).toBeGreaterThanOrEqual(
            Date.now()
         );
      });

      it('formats a quote from a Prisma-like row', () => {
         const quote = toQuote(row() as any, {
            ledger: 1000,
            closedAt: new Date(CLOSED_AT),
         });
         expect(quote).toMatchObject({
            startPrice: '100',
            floorPrice: '10',
            currentPrice: '100',
         });
      });
   });
});
