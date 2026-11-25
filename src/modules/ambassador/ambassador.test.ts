import express from 'express';
import request from 'supertest';
import { prisma } from '../../utils/prisma.utils';
import { AmbassadorService } from './ambassador.service';
import { ambassadorRouter, referralClickRouter } from './ambassador.routes';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      referralCode: {
         findUnique: jest.fn(),
      },
      referralClick: {
         create: jest.fn(),
         findFirst: jest.fn(),
         count: jest.fn(),
      },
      referralAttribution: {
         findUnique: jest.fn(),
         findMany: jest.fn(),
         create: jest.fn(),
         count: jest.fn(),
      },
      referralHold: {
         findFirst: jest.fn(),
         findMany: jest.fn(),
      },
      ambassadorPayout: {
         findMany: jest.fn(),
         upsert: jest.fn(),
      },
   },
}));

jest.mock('../../middlewares/jwt-auth.middleware', () => ({
   requireJwtAuth: (req: any, _res: any, next: any) => {
      req.user = { wallet: req.headers['x-test-wallet'] || 'GAMBASSADOR_1' };
      next();
   },
}));

const app = express();
app.use(express.json());
app.use('/v1/referrals', referralClickRouter);
app.use('/v1/ambassador', ambassadorRouter);

describe('Ambassador Referral Attribution & Payout Accrual (#1316)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('POST /v1/referrals/click', () => {
      it('records a referral click with UTM fields and first-party cookie id', async () => {
         (prisma.referralCode.findUnique as jest.Mock).mockResolvedValueOnce({
            walletAddress: 'GAMBASSADOR_1',
            code: 'AMB123',
         });
         (prisma.referralClick.create as jest.Mock).mockResolvedValueOnce({
            id: 'click-1',
            referrerWallet: 'GAMBASSADOR_1',
            referralCode: 'AMB123',
            cookieId: 'cookie-xyz',
            utmSource: 'twitter',
            utmMedium: 'social',
            utmCampaign: 'launch',
         });

         const res = await request(app).post('/v1/referrals/click').send({
            referralCode: 'AMB123',
            cookieId: 'cookie-xyz',
            utmSource: 'twitter',
            utmMedium: 'social',
            utmCampaign: 'launch',
         });

         expect(res.status).toBe(201);
         expect(res.body.data.referrerWallet).toBe('GAMBASSADOR_1');
         expect(res.body.data.cookieId).toBe('cookie-xyz');
      });
   });

   describe('30-day attribution window', () => {
      it('attributes a wallet on first connection to the last valid referral within 30 days', async () => {
         const now = new Date('2026-11-24T12:00:00Z');
         (prisma.referralAttribution.findUnique as jest.Mock).mockResolvedValueOnce(
            null
         );
         (prisma.referralClick.findFirst as jest.Mock).mockResolvedValueOnce({
            id: 'click-latest',
            referrerWallet: 'GAMBASSADOR_2',
            referralCode: 'CODE2',
            cookieId: 'cookie-1',
            clickedAt: new Date('2026-11-20T12:00:00Z'),
         });
         (prisma.referralHold.findFirst as jest.Mock).mockResolvedValueOnce(null);
         (prisma.referralAttribution.create as jest.Mock).mockImplementationOnce(
            ({ data }) => Promise.resolve({ id: 'attr-1', ...data })
         );

         const result = await AmbassadorService.attributeOnFirstConnection(
            'GREFEREE_1',
            'cookie-1',
            now
         );

         expect(result?.referrerWallet).toBe('GAMBASSADOR_2');
         expect(prisma.referralClick.findFirst).toHaveBeenCalledWith(
            expect.objectContaining({
               where: expect.objectContaining({
                  cookieId: 'cookie-1',
                  referrerWallet: { not: 'GREFEREE_1' },
                  clickedAt: {
                     gte: new Date('2026-10-25T12:00:00Z'),
                     lte: now,
                  },
               }),
               orderBy: [{ clickedAt: 'desc' }, { id: 'desc' }],
            })
         );
      });

      it('returns null when no click exists within the 30-day window', async () => {
         (prisma.referralAttribution.findUnique as jest.Mock).mockResolvedValueOnce(
            null
         );
         (prisma.referralClick.findFirst as jest.Mock).mockResolvedValueOnce(null);

         const result = await AmbassadorService.attributeOnFirstConnection(
            'GREFEREE_1',
            'cookie-old',
            new Date('2026-11-24T12:00:00Z')
         );

         expect(result).toBeNull();
         expect(prisma.referralAttribution.create).not.toHaveBeenCalled();
      });
   });

   describe('Tier computation & daily payout accrual', () => {
      it('applies tier share from the day active-trader thresholds are met and excludes self/held referrals', async () => {
         const day = new Date('2026-11-24T15:00:00Z');

         // 5 active traders => Tier 2 (15% share)
         (prisma.referralAttribution.findMany as jest.Mock).mockResolvedValueOnce([
            { refereeWallet: 'TRADER_1', firstTradeAt: new Date('2026-11-20T00:00:00Z') },
            { refereeWallet: 'TRADER_2', firstTradeAt: new Date('2026-11-21T00:00:00Z') },
            { refereeWallet: 'TRADER_3', firstTradeAt: new Date('2026-11-22T00:00:00Z') },
            { refereeWallet: 'TRADER_4', firstTradeAt: new Date('2026-11-23T00:00:00Z') },
            { refereeWallet: 'TRADER_5', firstTradeAt: null }, // first trade happens today!
            { refereeWallet: 'TRADER_HELD', firstTradeAt: new Date('2026-11-22T00:00:00Z') },
         ]);
         (prisma.referralHold.findMany as jest.Mock).mockResolvedValueOnce([
            { refereeAddress: 'TRADER_HELD' },
         ]);
         (prisma.ambassadorPayout.upsert as jest.Mock).mockImplementationOnce(
            ({ create }) => Promise.resolve({ id: 'pay-1', ...create })
         );

         const payout = await AmbassadorService.accrueDailyPayout(
            'GAMBASSADOR_1',
            day,
            [
               { traderWallet: 'TRADER_1', fee: 100, volume: 1000 },
               { traderWallet: 'TRADER_5', fee: 100, volume: 1000 },
               // Self-referral must be excluded
               { traderWallet: 'GAMBASSADOR_1', fee: 500, volume: 5000 },
               // Held referral must be excluded
               { traderWallet: 'TRADER_HELD', fee: 300, volume: 3000 },
            ]
         );

         // Eligible fees = 100 + 100 = 200; 5 active traders => Tier 2 (0.15) => accrued = 30
         expect(payout.tier).toBe(2);
         expect(payout.tierShare).toBe(0.15);
         expect(payout.activeTraders).toBe(5);
         expect(payout.totalFees).toBe(200);
         expect(payout.accruedAmount).toBe(30);
      });
   });

   describe('GET /v1/ambassador/stats & GET /v1/ambassador/payouts', () => {
      it('returns consistent funnel stats', async () => {
         (prisma.referralClick.count as jest.Mock).mockResolvedValueOnce(42);
         (prisma.referralAttribution.findMany as jest.Mock).mockResolvedValueOnce([
            { firstTradeAt: new Date(), tradeCount: 3, totalVolume: 500 },
            { firstTradeAt: new Date(), tradeCount: 1, totalVolume: 200 },
            { firstTradeAt: null, tradeCount: 0, totalVolume: 0 },
         ]);
         (prisma.ambassadorPayout.findMany as jest.Mock).mockResolvedValueOnce([
            { accruedAmount: 15 },
            { accruedAmount: 5 },
         ]);
         (prisma.referralAttribution.count as jest.Mock).mockResolvedValueOnce(2);

         const res = await request(app).get('/v1/ambassador/stats?range=30d');

         expect(res.status).toBe(200);
         expect(res.body.data).toMatchObject({
            clicks: 42,
            signUps: 3,
            firstTrades: 2,
            repeatTraders: 1,
            volume: 700,
            activeTraders: 2,
            tier: 1,
            tierShare: 0.1,
            accruedEarnings: 20,
         });
      });

      it('returns cursor-paginated payouts', async () => {
         (prisma.ambassadorPayout.findMany as jest.Mock).mockResolvedValueOnce([
            {
               id: 'p1',
               ambassadorWallet: 'GAMBASSADOR_1',
               payoutDate: new Date('2026-11-24T00:00:00Z'),
               tier: 1,
               tierShare: 0.1,
               totalFees: 100,
               accruedAmount: 10,
            },
            {
               id: 'p2',
               ambassadorWallet: 'GAMBASSADOR_1',
               payoutDate: new Date('2026-11-23T00:00:00Z'),
               tier: 1,
               tierShare: 0.1,
               totalFees: 50,
               accruedAmount: 5,
            },
         ]);

         const res = await request(app).get('/v1/ambassador/payouts?limit=1');

         expect(res.status).toBe(200);
         expect(res.body.data.items).toHaveLength(1);
         expect(res.body.data.hasMore).toBe(true);
         expect(typeof res.body.data.nextCursor).toBe('string');
      });
   });
});
