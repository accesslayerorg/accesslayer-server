// Route tests: GET /portfolio/history (#1008)
// Service is mocked; the real query schema and cache-control middleware are
// kept so validation and the 5-minute cache header are exercised.

jest.mock('./portfolio-history.service', () => ({
   ...jest.requireActual('./portfolio-history.service'),
   getPortfolioHistory: jest.fn(),
}));

import express from 'express';
import request from 'supertest';
import portfolioRouter from './portfolio.routes';
import { getPortfolioHistory } from './portfolio-history.service';

const mockGetPortfolioHistory = getPortfolioHistory as jest.Mock;

const WALLET = `G${'A'.repeat(55)}`;
const SERIES = {
   wallet: WALLET,
   range: '7d',
   interval: 'hourly',
   intervalMs: 3_600_000,
   currency: 'XLM',
   points: [
      { timestamp: '2026-10-16T12:00:00.000Z', value: 20 },
      { timestamp: '2026-10-16T13:00:00.000Z', value: 21 },
   ],
   firstValue: 20,
   lastValue: 21,
   percentageReturn: 5,
};

const app = express();
app.use(express.json());
app.use('/api/v1/portfolio', portfolioRouter);

beforeEach(() => {
   jest.clearAllMocks();
   mockGetPortfolioHistory.mockResolvedValue(SERIES);
});

describe('GET /api/v1/portfolio/history', () => {
   it('returns the series for the requested wallet and range', async () => {
      const res = await request(app)
         .get('/api/v1/portfolio/history')
         .query({ wallet: WALLET, range: '30d' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: SERIES });
      expect(mockGetPortfolioHistory).toHaveBeenCalledWith(WALLET, '30d');
   });

   it('defaults the range to 7d when it is omitted', async () => {
      const res = await request(app)
         .get('/api/v1/portfolio/history')
         .query({ wallet: WALLET });

      expect(res.status).toBe(200);
      expect(mockGetPortfolioHistory).toHaveBeenCalledWith(WALLET, '7d');
   });

   it('accepts every documented range', async () => {
      for (const range of ['7d', '30d', '90d', 'all']) {
         const res = await request(app)
            .get('/api/v1/portfolio/history')
            .query({ wallet: WALLET, range });

         expect(res.status).toBe(200);
         expect(mockGetPortfolioHistory).toHaveBeenLastCalledWith(
            WALLET,
            range
         );
      }
   });

   it('marks the response cacheable for 5 minutes', async () => {
      const res = await request(app)
         .get('/api/v1/portfolio/history')
         .query({ wallet: WALLET, range: '7d' });

      expect(res.headers['cache-control']).toBe('public, max-age=300');
   });

   it('rejects a malformed wallet address', async () => {
      const res = await request(app)
         .get('/api/v1/portfolio/history')
         .query({ wallet: 'not-a-wallet', range: '7d' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(mockGetPortfolioHistory).not.toHaveBeenCalled();
   });

   it('rejects an unsupported range', async () => {
      const res = await request(app)
         .get('/api/v1/portfolio/history')
         .query({ wallet: WALLET, range: '1y' });

      expect(res.status).toBe(400);
      expect(mockGetPortfolioHistory).not.toHaveBeenCalled();
   });

   it('rejects a missing wallet', async () => {
      const res = await request(app).get('/api/v1/portfolio/history');

      expect(res.status).toBe(400);
      expect(mockGetPortfolioHistory).not.toHaveBeenCalled();
   });

   it('rejects unknown query parameters', async () => {
      const res = await request(app)
         .get('/api/v1/portfolio/history')
         .query({ wallet: WALLET, foo: 'bar' });

      expect(res.status).toBe(400);
      expect(mockGetPortfolioHistory).not.toHaveBeenCalled();
   });

   it('rejects non-GET methods with 405', async () => {
      const res = await request(app)
         .post('/api/v1/portfolio/history')
         .send({ wallet: WALLET });

      expect(res.status).toBe(405);
      expect(mockGetPortfolioHistory).not.toHaveBeenCalled();
   });

   it('returns an empty series for a wallet with no history', async () => {
      mockGetPortfolioHistory.mockResolvedValue({
         wallet: WALLET,
         range: '7d',
         interval: 'hourly',
         intervalMs: 3_600_000,
         currency: 'XLM',
         points: [],
         firstValue: 0,
         lastValue: 0,
         percentageReturn: null,
      });

      const res = await request(app)
         .get('/api/v1/portfolio/history')
         .query({ wallet: WALLET, range: '7d' });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
         points: [],
         firstValue: 0,
         lastValue: 0,
         percentageReturn: null,
      });
   });
});
