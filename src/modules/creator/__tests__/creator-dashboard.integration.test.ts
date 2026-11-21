import request from 'supertest';
import express from 'express';
import { signWalletAccessToken } from '../../../utils/jwt.utils';
import creatorRouter from '../../creators/creators.routes';
import { prisma } from '../../../utils/prisma.utils';
import * as redisUtils from '../../../utils/redis.utils';
import { errorHandler } from '../../../middlewares/error.middleware';
import { invalidateCreatorDashboardCache } from '../creator-dashboard.service';

const app = express();
app.use(express.json());
app.use('/creator', creatorRouter);
app.use('/creators', creatorRouter);
app.use(errorHandler);

const CREATOR_WALLET = 'GACREATORTESTWALLET111111111111111111111111111';
const OTHER_WALLET = 'GAOTHERWALLET22222222222222222222222222222222';
const KEY_ID = 'creator-dash-key-101';
const USER_ID = 'user-dash-101';
const OTHER_USER_ID = 'user-dash-other-202';

describe('Creator Dashboard Summary Endpoint (Issue #833) - GET /creator/:keyId/dashboard', () => {
   let creatorToken: string;
   let nonCreatorToken: string;

   beforeAll(() => {
      creatorToken = signWalletAccessToken(CREATOR_WALLET);
      nonCreatorToken = signWalletAccessToken(OTHER_WALLET);
   });

   beforeEach(() => {
      jest.restoreAllMocks();

      (
         jest.spyOn(prisma.creatorProfile, 'findFirst') as any
      ).mockImplementation((args: any) => {
         const where = args?.where;
         if (
            where?.OR?.some(
               (cond: any) => cond.id === KEY_ID || cond.handle === KEY_ID
            )
         ) {
            return Promise.resolve({
               id: KEY_ID,
               userId: USER_ID,
               handle: 'testdash',
               circulatingSupply: '150',
               creatorRoyaltyBuyBps: 500, // 5%
               creatorRoyaltySellBps: 500,
               priceSnapshot: {
                  currentPrice: 2000000n, // 20 XLM stroops
                  price24hAgo: 1000000n, // 10 XLM stroops (+100% change)
               },
            });
         }
         return Promise.resolve(null);
      });

      (
         jest.spyOn(prisma.stellarWallet, 'findUnique') as any
      ).mockImplementation((args: any) => {
         if (args?.where?.address === CREATOR_WALLET) {
            return Promise.resolve({
               address: CREATOR_WALLET,
               userId: USER_ID,
            });
         }
         if (args?.where?.address === OTHER_WALLET) {
            return Promise.resolve({
               address: OTHER_WALLET,
               userId: OTHER_USER_ID,
            });
         }
         return Promise.resolve(null);
      });

      // Key ownership for holderCount
      (jest.spyOn(prisma.keyOwnership, 'count') as any).mockResolvedValue(12);

      // Trades for tradeCount and totalRoyaltyEarned: 2 trades, price 1000, qty 10, royalty 5% = 50 each
      (jest.spyOn(prisma.trade, 'findMany') as any).mockResolvedValue([
         { price: '1000', quantity: '10' },
         { price: '2000', quantity: '5' },
      ]);

      // Dividends for totalDividendsDistributed
      (
         jest.spyOn(prisma.dividendDistribution, 'aggregate') as any
      ).mockResolvedValue({
         _sum: { totalAmountXlm: 250 },
      });

      // Price history
      (
         jest.spyOn(prisma.creatorPriceHistory, 'findMany') as any
      ).mockResolvedValue([]);
   });

   it('returns 403 when non-creator wallet attempts to fetch dashboard', async () => {
      const res = await request(app)
         .get(`/creator/${KEY_ID}/dashboard`)
         .set('Authorization', `Bearer ${nonCreatorToken}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
   });

   it('returns all required metrics in a single response with priceChange24h computed', async () => {
      jest.spyOn(redisUtils, 'cacheGetJson').mockResolvedValue(null);
      const cacheSetSpy = jest
         .spyOn(redisUtils, 'cacheSetJson')
         .mockResolvedValue(undefined as any);

      const res = await request(app)
         .get(`/creator/${KEY_ID}/dashboard`)
         .set('Authorization', `Bearer ${creatorToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({
         currentPrice: '2000000',
         circulatingSupply: '150',
         holderCount: 12,
         totalRoyaltyEarned: '1000',
         totalDividendsDistributed: '250',
         tradeCount: 2,
         priceChange24h: 100,
      });

      expect(cacheSetSpy).toHaveBeenCalledWith(
         `creator:dashboard:${KEY_ID}`,
         expect.objectContaining({
            currentPrice: '2000000',
            holderCount: 12,
         }),
         120 // 2 minutes TTL
      );
   });

   it('serves dashboard from Redis cache within TTL on cache hit', async () => {
      const cachedDashboard = {
         currentPrice: '3000000',
         circulatingSupply: '200',
         holderCount: 25,
         totalRoyaltyEarned: '500',
         totalDividendsDistributed: '300',
         tradeCount: 10,
         priceChange24h: 50,
      };

      jest.spyOn(redisUtils, 'cacheGetJson').mockResolvedValue(cachedDashboard);
      const dbTradeSpy = jest.spyOn(prisma.trade, 'findMany');

      const res = await request(app)
         .get(`/creator/${KEY_ID}/dashboard`)
         .set('Authorization', `Bearer ${creatorToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual(cachedDashboard);
      // DB queries bypassed
      expect(dbTradeSpy).not.toHaveBeenCalled();
   });

   it('invalidates cache when invalidateCreatorDashboardCache is called', async () => {
      const invalidateSpy = jest
         .spyOn(redisUtils, 'cacheInvalidate')
         .mockResolvedValue(undefined as any);

      await invalidateCreatorDashboardCache(KEY_ID);

      expect(invalidateSpy).toHaveBeenCalledWith(
         `creator:dashboard:${KEY_ID}`,
         `creator-dashboard:${KEY_ID}`
      );
   });
});
