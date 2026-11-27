import express from 'express';
import request from 'supertest';
import { prisma } from '../../utils/prisma.utils';
import { cacheGet, cacheSet } from '../../utils/redis.utils';
import { HourlyAggregator } from '../../workers/hourly-aggregator.worker';
import { activityHeatmapRouter } from './activity-heatmap.routes';
import {
   getActivityHeatmap,
   HEATMAP_CACHE_TTL_SECONDS,
   toZonedWeekdayAndHour,
} from './activity-heatmap.service';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      trade: {
         findMany: jest.fn(),
      },
      tradeHourlyStat: {
         findMany: jest.fn(),
         upsert: jest.fn(),
      },
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheGet: jest.fn().mockResolvedValue(null),
   cacheSet: jest.fn().mockResolvedValue(undefined),
}));

const app = express();
app.use('/v1/keys', activityHeatmapRouter);

describe('Trading Activity Heatmap (#1317)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      (cacheGet as jest.Mock).mockResolvedValue(null);
   });

   describe('Timezone shifting & Daylight Saving Time', () => {
      it('shifts UTC buckets across DST boundary in America/New_York', () => {
         // 2026-11-01 05:00 UTC: EDT (UTC-4) => 01:00 AM Sunday (Nov 1 2026 02:00 EDT falls back to 01:00 EST)
         const beforeFallback = new Date('2026-11-01T05:00:00Z');
         // 2026-11-01 07:00 UTC: EST (UTC-5) => 02:00 AM Sunday
         const afterFallback = new Date('2026-11-01T07:00:00Z');

         expect(
            toZonedWeekdayAndHour(beforeFallback, 'America/New_York')
         ).toEqual({
            weekday: 0,
            hour: 1,
         });
         expect(
            toZonedWeekdayAndHour(afterFallback, 'America/New_York')
         ).toEqual({
            weekday: 0,
            hour: 2,
         });
      });

      it('builds 7x24 matrix, totals, busiest slot, and caches for 5 minutes', async () => {
         (prisma.tradeHourlyStat.findMany as jest.Mock).mockResolvedValueOnce([
            {
               bucketStart: new Date('2026-11-23T14:00:00Z'), // Mon 14:00 UTC = Mon 09:00 America/New_York
               trades: 5,
               volume: 250,
            },
            {
               bucketStart: new Date('2026-11-23T18:00:00Z'), // Mon 18:00 UTC = Mon 13:00 America/New_York
               trades: 12,
               volume: 600,
            },
         ]);

         const result = await getActivityHeatmap(
            'key-1',
            30,
            'America/New_York',
            new Date('2026-11-24T12:00:00Z')
         );

         expect(result.matrix).toHaveLength(7);
         expect(result.matrix[0]).toHaveLength(24);
         expect(result.matrix[1][9].trades).toBe(5);
         expect(result.matrix[1][13].trades).toBe(12);
         expect(result.totalTrades).toBe(17);
         expect(result.totalVolume).toBe(850);
         expect(result.busiestSlot).toEqual({
            weekday: 1,
            hour: 13,
            trades: 12,
            volume: 600,
         });
         expect(cacheSet).toHaveBeenCalledWith(
            'keys:heatmap:key-1:30:America/New_York',
            expect.any(String),
            HEATMAP_CACHE_TTL_SECONDS
         );
      });
   });

   describe('Validation (400 on invalid tz or range)', () => {
      it('returns 400 for invalid tz', async () => {
         const res = await request(app).get(
            '/v1/keys/key-1/activity-heatmap?range=30&tz=Invalid/Timezone'
         );
         expect(res.status).toBe(400);
      });

      it('returns 400 for unsupported range', async () => {
         const res = await request(app).get(
            '/v1/keys/key-1/activity-heatmap?range=14&tz=UTC'
         );
         expect(res.status).toBe(400);
      });
   });

   describe('HourlyAggregator live vs backfill parity', () => {
      it('produces identical totals for backfill and live aggregation', async () => {
         const now = new Date('2026-11-24T14:35:00Z');
         const sampleTrades = [
            {
               creatorId: 'key-1',
               quantity: '2',
               price: '10',
               timestamp: new Date('2026-11-24T13:15:00Z'),
            },
            {
               creatorId: 'key-1',
               quantity: '3',
               price: '10',
               timestamp: new Date('2026-11-24T14:10:00Z'),
            },
         ];

         (prisma.trade.findMany as jest.Mock).mockResolvedValue(sampleTrades);
         (prisma.tradeHourlyStat.upsert as jest.Mock).mockResolvedValue({});

         const live = await HourlyAggregator.runLive(now);
         const backfilled = await HourlyAggregator.backfill(
            new Date('2026-11-24T13:00:00Z'),
            new Date('2026-11-24T14:59:59Z')
         );

         expect(live).toEqual(backfilled);
         expect(live).toHaveLength(2);
         expect(live.reduce((s, b) => s + b.trades, 0)).toBe(2);
         expect(live.reduce((s, b) => s + b.volume, 0)).toBe(50);
      });
   });
});
