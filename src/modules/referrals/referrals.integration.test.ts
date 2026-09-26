// Route-level tests for the referral programme endpoints (#910).
//
// Exercises the mounted /referrals router (auth guard, validation, status
// codes and response envelopes) with a mocked Prisma layer so the behaviour
// can be asserted without a live database.

jest.mock('tspec', () => ({
   TspecDocsMiddleware: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      referralCode: { findUnique: jest.fn(), create: jest.fn() },
      referral: {
         findUnique: jest.fn(),
         findMany: jest.fn(),
         create: jest.fn(),
         count: jest.fn(),
         updateMany: jest.fn(),
      },
      referralEvent: {
         create: jest.fn(),
         aggregate: jest.fn(),
         groupBy: jest.fn(),
      },
   },
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      isLevelEnabled: jest.fn().mockReturnValue(false),
   },
}));

import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';
import { signWalletAccessToken } from '../../utils/jwt.utils';
import { REFERRAL_CODE_LENGTH } from './referrals.constants';

const codeFindUnique = prisma.referralCode.findUnique as jest.Mock;
const codeCreate = prisma.referralCode.create as jest.Mock;
const referralFindUnique = prisma.referral.findUnique as jest.Mock;
const referralFindMany = prisma.referral.findMany as jest.Mock;
const referralCreate = prisma.referral.create as jest.Mock;
const referralCount = prisma.referral.count as jest.Mock;
const eventAggregate = prisma.referralEvent.aggregate as jest.Mock;
const eventGroupBy = prisma.referralEvent.groupBy as jest.Mock;

const REFERRER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const REFEREE = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CODE = 'ABCD2345EF';

function auth(wallet: string) {
   return { Authorization: `Bearer ${signWalletAccessToken(wallet)}` };
}

function referralRow(overrides: Record<string, unknown> = {}) {
   return {
      id: 'ref-1',
      referrerAddress: REFERRER,
      refereeAddress: REFEREE,
      referralCode: CODE,
      firstTradeAt: null,
      firstTradeKeyId: null,
      createdAt: new Date('2026-09-01T10:00:00.000Z'),
      updatedAt: new Date('2026-09-01T10:00:00.000Z'),
      ...overrides,
   };
}

describe('referral routes', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      eventGroupBy.mockResolvedValue([]);
   });

   describe('POST /api/v1/referrals/register', () => {
      it('requires authentication', async () => {
         const res = await supertest(app)
            .post('/api/v1/referrals/register')
            .send({ referralCode: CODE });

         expect(res.status).toBe(401);
         expect(referralCreate).not.toHaveBeenCalled();
      });

      it('links the authenticated wallet to the owner of the referral code', async () => {
         codeFindUnique.mockResolvedValue({ walletAddress: REFERRER });
         referralFindUnique.mockResolvedValue(null);
         referralCreate.mockResolvedValue(referralRow({ id: 'ref-42' }));

         const res = await supertest(app)
            .post('/api/v1/referrals/register')
            .set(auth(REFEREE))
            .send({ referralCode: CODE });

         expect(res.status).toBe(201);
         expect(res.body).toEqual(
            expect.objectContaining({
               success: true,
               data: expect.objectContaining({
                  referralId: 'ref-42',
                  referrerAddress: REFERRER,
                  refereeAddress: REFEREE,
                  status: 'PENDING',
               }),
            })
         );
         expect(referralCreate).toHaveBeenCalledWith({
            data: {
               referrerAddress: REFERRER,
               refereeAddress: REFEREE,
               referralCode: CODE,
            },
         });
      });

      it('returns 409 when the wallet has already been referred', async () => {
         codeFindUnique.mockResolvedValue({ walletAddress: REFERRER });
         referralFindUnique.mockResolvedValue({
            referrerAddress: 'GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
         });

         const res = await supertest(app)
            .post('/api/v1/referrals/register')
            .set(auth(REFEREE))
            .send({ referralCode: CODE });

         expect(res.status).toBe(409);
         expect(res.body).toEqual(
            expect.objectContaining({
               success: false,
               error: expect.objectContaining({ code: 'CONFLICT' }),
            })
         );
         expect(referralCreate).not.toHaveBeenCalled();
      });

      it('returns 404 for an unknown referral code', async () => {
         codeFindUnique.mockResolvedValue(null);

         const res = await supertest(app)
            .post('/api/v1/referrals/register')
            .set(auth(REFEREE))
            .send({ referralCode: 'NOPE1234XX' });

         expect(res.status).toBe(404);
         expect(res.body).toEqual(
            expect.objectContaining({
               success: false,
               error: expect.objectContaining({ code: 'NOT_FOUND' }),
            })
         );
      });

      it('returns 400 when a wallet registers with its own code', async () => {
         codeFindUnique.mockResolvedValue({ walletAddress: REFEREE });

         const res = await supertest(app)
            .post('/api/v1/referrals/register')
            .set(auth(REFEREE))
            .send({ referralCode: CODE });

         expect(res.status).toBe(400);
         expect(res.body).toEqual(
            expect.objectContaining({
               success: false,
               error: expect.objectContaining({ code: 'BAD_REQUEST' }),
            })
         );
      });

      it('returns 400 when the referral code is missing', async () => {
         const res = await supertest(app)
            .post('/api/v1/referrals/register')
            .set(auth(REFEREE))
            .send({});

         expect(res.status).toBe(400);
         expect(res.body.error.details[0].field).toBe('referralCode');
         expect(referralCreate).not.toHaveBeenCalled();
      });
   });

   describe('GET /api/v1/referrals/earnings', () => {
      beforeEach(() => {
         codeFindUnique.mockResolvedValue({ code: CODE });
         referralCount.mockResolvedValue(0);
      });

      it('requires authentication', async () => {
         const res = await supertest(app).get('/api/v1/referrals/earnings');
         expect(res.status).toBe(401);
      });

      it('returns the total earned and a per-referral breakdown', async () => {
         const firstTradeAt = new Date('2026-09-05T12:00:00.000Z');
         eventAggregate.mockResolvedValue({ _sum: { amount: '7.25' } });
         referralCount.mockImplementation(async ({ where }: any) =>
            where.firstTradeAt ? 1 : 2
         );
         referralFindMany.mockResolvedValue([
            referralRow({ id: 'ref-1', firstTradeAt }),
            referralRow({ id: 'ref-2', refereeAddress: 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' }),
         ]);
         eventGroupBy.mockResolvedValue([
            { refereeAddress: REFEREE, _sum: { amount: '7.25' } },
         ]);

         const res = await supertest(app)
            .get('/api/v1/referrals/earnings')
            .set(auth(REFERRER));

         expect(res.status).toBe(200);
         expect(res.body.data).toEqual(
            expect.objectContaining({
               referralCode: CODE,
               totalEarned: 7.25,
               rewardedReferralCount: 1,
               referredCount: 2,
            })
         );
         expect(res.body.data.breakdown).toHaveLength(2);
         expect(res.body.data.breakdown[0]).toEqual(
            expect.objectContaining({
               refereeAddress: REFEREE,
               firstTradeAt: '2026-09-05T12:00:00.000Z',
               status: 'ACTIVE',
               earnedXlm: 7.25,
            })
         );
         expect(res.body.data.breakdown[1]).toEqual(
            expect.objectContaining({
               status: 'PENDING',
               firstTradeAt: null,
               earnedXlm: 0,
            })
         );
      });

      it('returns zero totals for a wallet that has referred nobody', async () => {
         eventAggregate.mockResolvedValue({ _sum: { amount: null } });
         referralFindMany.mockResolvedValue([]);

         const res = await supertest(app)
            .get('/api/v1/referrals/earnings')
            .set(auth(REFERRER));

         expect(res.status).toBe(200);
         expect(res.body.data).toEqual(
            expect.objectContaining({
               totalEarned: 0,
               referredCount: 0,
               rewardedReferralCount: 0,
               breakdown: [],
            })
         );
      });

      it('issues a referral code on first read', async () => {
         codeFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
         codeCreate.mockImplementation(async ({ data }: any) => ({
            code: data.code,
         }));
         eventAggregate.mockResolvedValue({ _sum: { amount: '0' } });
         referralFindMany.mockResolvedValue([]);

         const res = await supertest(app)
            .get('/api/v1/referrals/earnings')
            .set(auth(REFERRER));

         expect(res.status).toBe(200);
         expect(res.body.data.referralCode).toHaveLength(REFERRAL_CODE_LENGTH);
      });

      it('rejects an out-of-range limit', async () => {
         const res = await supertest(app)
            .get('/api/v1/referrals/earnings?limit=0')
            .set(auth(REFERRER));

         expect(res.status).toBe(400);
         expect(res.body.error.details[0].field).toBe('limit');
      });
   });

   describe('GET /api/v1/referrals/referred', () => {
      it('requires authentication', async () => {
         const res = await supertest(app).get('/api/v1/referrals/referred');
         expect(res.status).toBe(401);
      });

      it('lists referred wallets with their join date and first-trade status', async () => {
         referralFindMany.mockResolvedValue([
            referralRow({ id: 'ref-1', firstTradeAt: new Date('2026-09-05T12:00:00.000Z') }),
            referralRow({ id: 'ref-2', refereeAddress: 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' }),
         ]);

         const res = await supertest(app)
            .get('/api/v1/referrals/referred')
            .set(auth(REFERRER));

         expect(res.status).toBe(200);
         expect(res.body.data.referred).toEqual([
            {
               refereeAddress: REFEREE,
               joinedAt: '2026-09-01T10:00:00.000Z',
               firstTradeAt: '2026-09-05T12:00:00.000Z',
               hasCompletedFirstTrade: true,
               status: 'ACTIVE',
               earnedXlm: 0,
            },
            {
               refereeAddress: 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
               joinedAt: '2026-09-01T10:00:00.000Z',
               firstTradeAt: null,
               hasCompletedFirstTrade: false,
               status: 'PENDING',
               earnedXlm: 0,
            },
         ]);
         expect(res.body.data.pagination).toEqual({
            limit: 20,
            nextCursor: null,
            hasMore: false,
         });
      });
   });

   describe('method handling', () => {
      it('returns 405 with an Allow header for unsupported methods', async () => {
         const res = await supertest(app)
            .post('/api/v1/referrals/earnings')
            .set(auth(REFERRER))
            .send({});

         expect(res.status).toBe(405);
         expect(res.headers.allow).toBe('GET');
      });
   });
});
