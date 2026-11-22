// Route test: GET /discovery/spotlight (#1151)
// Service is mocked; the route wires up the successful JSON response.

jest.mock('./discovery.service', () => {
   const actual = jest.requireActual('./discovery.service');
   return {
      ...actual,
      getSpotlight: jest.fn(),
   };
});

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      trade: { findMany: jest.fn() },
      creatorProfile: { findMany: jest.fn() },
   },
}));

import express from 'express';
import request from 'supertest';
import discoveryRouter from './discovery.routes';
import { getSpotlight, invalidateDiscoveryCache } from './discovery.service';
import { WARM_TARGETS } from '../../config/cache-warm';
import { prisma } from '../../utils/prisma.utils';

const mockGetSpotlight = getSpotlight as jest.Mock;
const mockPrisma = prisma as unknown as {
   trade: { findMany: jest.Mock };
   creatorProfile: { findMany: jest.Mock };
};

const app = express();
app.use(express.json());
app.use('/api/v1/discovery', discoveryRouter);

beforeEach(() => {
   jest.clearAllMocks();
   invalidateDiscoveryCache();
   mockPrisma.trade.findMany.mockResolvedValue([]);
   mockPrisma.creatorProfile.findMany.mockResolvedValue([]);
});

describe('GET /api/v1/discovery/spotlight', () => {
   it('returns the active spotlight payload from the service', async () => {
      const payload = {
         key_id: 'spot-1',
         name: 'Spotlight',
         creator: 'creator-handle',
         current_price: '500',
         '24h_volume': '1000',
         holder_count: 42,
         end_time: '2025-01-01T00:00:00.000Z',
         winning_bid: '123.45',
         time_remaining_seconds: 60,
      };
      mockGetSpotlight.mockResolvedValue(payload);

      const res = await request(app).get('/api/v1/discovery/spotlight');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(payload);
   });

   it('returns no_spotlight: true when no active spotlight exists', async () => {
      const payload = { no_spotlight: true };
      mockGetSpotlight.mockResolvedValue(payload);

      const res = await request(app).get('/api/v1/discovery/spotlight');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual(payload);
   });

   it('propagates service errors to the global error handler', async () => {
      mockGetSpotlight.mockRejectedValue(new Error('Database offline'));

      const res = await request(app).get('/api/v1/discovery/spotlight');

      // Supertest wraps it and Express default error handler kicks in if not defined
      expect(res.status).toBe(500);
   });
});

describe('GET /api/v1/discovery/trending', () => {
   it('serves a cache entry warmed through the configured service on the first request', async () => {
      const target = WARM_TARGETS.find(item => item.name === 'trending');
      if (!target) throw new Error('Trending cache warm target is missing');

      await target.warm();
      expect(mockPrisma.trade.findMany).toHaveBeenCalledTimes(1);

      const res = await request(app).get('/api/v1/discovery/trending');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockPrisma.trade.findMany).toHaveBeenCalledTimes(1);
   });
});
