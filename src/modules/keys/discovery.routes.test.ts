// Route test: GET /discovery/spotlight (#1151)
// Service is mocked; the route wires up the successful JSON response.

jest.mock('./discovery.service', () => {
   const actual = jest.requireActual('./discovery.service');
   return {
      ...actual,
      getSpotlight: jest.fn(),
   };
});

import express from 'express';
import request from 'supertest';
import discoveryRouter from './discovery.routes';
import { getSpotlight } from './discovery.service';

const mockGetSpotlight = getSpotlight as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/v1/discovery', discoveryRouter);

beforeEach(() => {
   jest.clearAllMocks();
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
