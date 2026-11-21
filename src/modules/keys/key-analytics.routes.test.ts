// Route tests: GET /keys/:keyId/analytics and GET /admin/analytics (#916)
// Service is mocked; the real query schema is kept so validation is exercised.

jest.mock('./key-analytics.service', () => {
   const actual = jest.requireActual('./key-analytics.service');
   return {
      ...actual,
      getKeyAnalytics: jest.fn(),
      getPlatformAnalytics: jest.fn(),
   };
});

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import keysRouter from './keys.routes';
import adminRouter from '../admin/admin.routes';
import { KeyNotFoundError } from './key-fees.service';
import { getKeyAnalytics, getPlatformAnalytics } from './key-analytics.service';
import { envConfig } from '../../config';

const mockGetKeyAnalytics = getKeyAnalytics as jest.Mock;
const mockGetPlatformAnalytics = getPlatformAnalytics as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/v1/keys', keysRouter);
app.use('/api/v1/admin', adminRouter);

const adminToken = jwt.sign({ sub: 'admin-1', role: 'admin' }, envConfig.JWT_SECRET);
const userToken = jwt.sign({ sub: 'user-1', role: 'user' }, envConfig.JWT_SECRET);

beforeEach(() => {
   jest.clearAllMocks();
});

describe('GET /api/v1/keys/:keyId/analytics', () => {
   it('returns trade_count, unique_traders and total_volume', async () => {
      const analytics = {
         keyId: 'key-1',
         trade_count: 3,
         unique_traders: 2,
         total_volume: '950',
         from: null,
         to: null,
      };
      mockGetKeyAnalytics.mockResolvedValue(analytics);

      const res = await request(app).get('/api/v1/keys/key-1/analytics');

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(analytics);
      expect(mockGetKeyAnalytics).toHaveBeenCalledWith('key-1', {
         from: undefined,
         to: undefined,
      });
   });

   it('passes the parsed time window to the service', async () => {
      mockGetKeyAnalytics.mockResolvedValue({});

      await request(app)
         .get('/api/v1/keys/key-1/analytics')
         .query({ from: '2026-09-01T00:00:00Z', to: '2026-09-30T00:00:00Z' });

      expect(mockGetKeyAnalytics).toHaveBeenCalledWith('key-1', {
         from: new Date('2026-09-01T00:00:00Z'),
         to: new Date('2026-09-30T00:00:00Z'),
      });
   });

   it('returns 400 for an invalid datetime', async () => {
      const res = await request(app)
         .get('/api/v1/keys/key-1/analytics')
         .query({ from: 'last-week' });

      expect(res.status).toBe(400);
      expect(mockGetKeyAnalytics).not.toHaveBeenCalled();
   });

   it('returns 400 when from is after to', async () => {
      const res = await request(app)
         .get('/api/v1/keys/key-1/analytics')
         .query({ from: '2026-09-30T00:00:00Z', to: '2026-09-01T00:00:00Z' });

      expect(res.status).toBe(400);
      expect(mockGetKeyAnalytics).not.toHaveBeenCalled();
   });

   it('returns 404 for an unknown key', async () => {
      mockGetKeyAnalytics.mockRejectedValue(new KeyNotFoundError('missing'));

      const res = await request(app).get('/api/v1/keys/missing/analytics');

      expect(res.status).toBe(404);
   });
});

describe('GET /api/v1/admin/analytics', () => {
   it('returns platform totals for an admin', async () => {
      const analytics = {
         trade_count: 5,
         unique_traders: 3,
         total_volume: '1160',
         key_count: 2,
         from: null,
         to: null,
      };
      mockGetPlatformAnalytics.mockResolvedValue(analytics);

      const res = await request(app)
         .get('/api/v1/admin/analytics')
         .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(analytics);
   });

   it('passes the parsed time window to the service', async () => {
      mockGetPlatformAnalytics.mockResolvedValue({});

      await request(app)
         .get('/api/v1/admin/analytics')
         .query({ from: '2026-09-01T00:00:00Z' })
         .set('Authorization', `Bearer ${adminToken}`);

      expect(mockGetPlatformAnalytics).toHaveBeenCalledWith({
         from: new Date('2026-09-01T00:00:00Z'),
         to: undefined,
      });
   });

   it('returns 400 for an invalid window', async () => {
      const res = await request(app)
         .get('/api/v1/admin/analytics')
         .query({ to: 'not-a-date' })
         .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
      expect(mockGetPlatformAnalytics).not.toHaveBeenCalled();
   });

   it('returns 401 without a token', async () => {
      const res = await request(app).get('/api/v1/admin/analytics');
      expect(res.status).toBe(401);
      expect(mockGetPlatformAnalytics).not.toHaveBeenCalled();
   });

   it('returns 403 for a non-admin token', async () => {
      const res = await request(app)
         .get('/api/v1/admin/analytics')
         .set('Authorization', `Bearer ${userToken}`);
      expect(res.status).toBe(403);
      expect(mockGetPlatformAnalytics).not.toHaveBeenCalled();
   });
});
