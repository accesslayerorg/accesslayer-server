// src/modules/traders/traders.routes.test.ts
import express from 'express';
import request from 'supertest';
import tradersRouter from './traders.routes';
import * as traderDiscountService from './trader-discount.service';

jest.mock('./trader-discount.service', () => ({
   getTraderDiscount: jest.fn(),
}));

describe('TradersRoutes', () => {
   const app = express();
   app.use(express.json());
   app.use('/api/v1/traders', tradersRouter);
   app.use('/traders', tradersRouter);

   const VALID_WALLET = 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G6EXO2Z6K35GUR223746';

   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('GET /api/v1/traders/:wallet/discount', () => {
      it('returns 200 with current tier, discount bps, and 30d volume for a valid wallet', async () => {
         const mockDiscount = {
            wallet: VALID_WALLET,
            tier: 1,
            tierLabel: 'TIER_1',
            discountBps: 100,
            volume30d: '1000000000000',
            volume30dStroops: '1000000000000',
         };
         (traderDiscountService.getTraderDiscount as jest.Mock).mockResolvedValue(
            mockDiscount
         );

         const res = await request(app).get(`/api/v1/traders/${VALID_WALLET}/discount`);

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data).toEqual(mockDiscount);
         expect(traderDiscountService.getTraderDiscount).toHaveBeenCalledWith(
            VALID_WALLET
         );
      });

      it('returns 400 validation error for an invalid Stellar wallet address', async () => {
         const res = await request(app).get('/api/v1/traders/invalid-wallet-address/discount');

         expect(res.status).toBe(400);
         expect(res.body.success).toBe(false);
         expect(res.body.error).toBeDefined();
         expect(res.body.error.code).toBe('VALIDATION_ERROR');
         expect(traderDiscountService.getTraderDiscount).not.toHaveBeenCalled();
      });

      it('also works at top-level /traders/:wallet/discount', async () => {
         const mockDiscount = {
            wallet: VALID_WALLET,
            tier: 0,
            tierLabel: 'TIER_0',
            discountBps: 0,
            volume30d: '0',
            volume30dStroops: '0',
         };
         (traderDiscountService.getTraderDiscount as jest.Mock).mockResolvedValue(
            mockDiscount
         );

         const res = await request(app).get(`/traders/${VALID_WALLET}/discount`);

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data).toEqual(mockDiscount);
      });
   });
});
