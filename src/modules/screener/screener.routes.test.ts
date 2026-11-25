import express from 'express';
import request from 'supertest';

const mockRun = jest.fn();
const mockListScreens = jest.fn();
const mockCreateScreen = jest.fn();
const mockDeleteScreen = jest.fn();

jest.mock('./screener.service', () => {
   const actual = jest.requireActual('./screener.service');
   return {
      ...actual,
      ScreenerService: {
         run: (...args: any[]) => mockRun(...args),
         listScreens: (...args: any[]) => mockListScreens(...args),
         createScreen: (...args: any[]) => mockCreateScreen(...args),
         deleteScreen: (...args: any[]) => mockDeleteScreen(...args),
      },
   };
});

jest.mock('../../middlewares/jwt-auth.middleware', () => ({
   requireJwtAuth: (req: any, _res: any, next: any) => {
      req.user = { wallet: 'GWALLET_TEST' };
      next();
   },
}));

import { screenerRouter, screensRouter } from './screener.routes';
import {
   SavedScreenLimitError,
   SavedScreenNotFoundError,
} from './screener.service';

const app = express();
app.use(express.json());
app.use('/v1/screener', screenerRouter);
app.use('/v1/screens', screensRouter);

describe('Screener & Screens routes (#1312)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('returns 400 for unsupported metric or operator', async () => {
      const badMetric = await request(app)
         .post('/v1/screener/run')
         .send({
            rules: [{ metric: 'secret_col', operator: 'gt', value: 1 }],
         });
      expect(badMetric.status).toBe(400);

      const badOp = await request(app)
         .post('/v1/screener/run')
         .send({
            rules: [{ metric: 'price', operator: 'like', value: 1 }],
         });
      expect(badOp.status).toBe(400);
   });

   it('returns 400 when more than 10 rules are provided', async () => {
      const rules = Array.from({ length: 11 }, (_, i) => ({
         metric: 'price',
         operator: 'gt',
         value: i,
      }));
      const res = await request(app).post('/v1/screener/run').send({ rules });
      expect(res.status).toBe(400);
   });

   it('returns descriptive 400 for contradictory rules', async () => {
      const res = await request(app)
         .post('/v1/screener/run')
         .send({
            rules: [
               { metric: 'price', operator: 'gt', value: 100 },
               { metric: 'price', operator: 'lt', value: 50 },
            ],
         });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/Contradictory rules/);
   });

   it('returns matches, totalCount, and cursor on POST /v1/screener/run', async () => {
      mockRun.mockResolvedValue({
         matches: [{ keyId: 'k1', price: 100 }],
         totalCount: 1,
         cursor: null,
      });

      const res = await request(app)
         .post('/v1/screener/run')
         .send({
            rules: [{ metric: 'price', operator: 'gte', value: 100 }],
         });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
         matches: [{ keyId: 'k1', price: 100 }],
         totalCount: 1,
         cursor: null,
      });
   });

   it('supports GET/POST/DELETE /v1/screens and returns 400 at limit', async () => {
      mockListScreens.mockResolvedValue([]);
      const listRes = await request(app).get('/v1/screens');
      expect(listRes.status).toBe(200);

      mockCreateScreen.mockRejectedValueOnce(new SavedScreenLimitError());
      const limitRes = await request(app)
         .post('/v1/screens')
         .send({ name: 'Test', rules: [] });
      expect(limitRes.status).toBe(400);

      mockDeleteScreen.mockRejectedValueOnce(new SavedScreenNotFoundError());
      const delRes = await request(app).delete('/v1/screens/missing');
      expect(delRes.status).toBe(404);
   });
});
