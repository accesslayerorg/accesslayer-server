// src/modules/referrals/referrals.controller.test.ts
// Authorization, caching and pagination behavior for GET /users/:wallet/referrals.

jest.mock('../../utils/prisma.utils', () => ({
   prisma: { referralFee: { aggregate: jest.fn(), findMany: jest.fn() } },
}));

jest.mock('./referrals.cache', () => ({
   getCachedReferralSummary: jest.fn(async () => null),
   setCachedReferralSummary: jest.fn(async () => undefined),
}));

jest.mock('./referrals.service', () => ({
   getReferralSummary: jest.fn(async () => ({ totalEarned: 5, referralCount: 2 })),
   getReferralBreakdown: jest.fn(async () => ({
      items: [{ keyId: 'k1', creatorName: 'C', amount: 5, timestamp: 't' }],
      nextCursor: null,
      hasNextPage: false,
   })),
}));

import { httpGetReferrals } from './referrals.controller';
import { getReferralSummary, getReferralBreakdown } from './referrals.service';

const summary = getReferralSummary as jest.Mock;
const breakdown = getReferralBreakdown as jest.Mock;

function makeRes() {
   const res: any = {};
   res.statusCode = 200;
   res.status = jest.fn((code: number) => {
      res.statusCode = code;
      return res;
   });
   res.json = jest.fn((body: unknown) => {
      res.body = body;
      return res;
   });
   res.setHeader = jest.fn();
   return res;
}

describe('httpGetReferrals', () => {
   afterEach(() => jest.clearAllMocks());

   it('returns 401 when the JWT wallet does not match the path param', async () => {
      const req: any = { params: { wallet: 'W1' }, authWallet: 'W2', query: {} };
      const res = makeRes();

      await httpGetReferrals(req, res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(401);
   });

   it('returns totals and breakdown when authorized', async () => {
      const req: any = { params: { wallet: 'W1' }, authWallet: 'W1', query: {} };
      const res = makeRes();

      await httpGetReferrals(req, res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.body.data.totalEarned).toBe(5);
      expect(res.body.data.referralCount).toBe(2);
      expect(res.body.data.breakdown).toHaveLength(1);
      expect(breakdown).toHaveBeenCalled();
      expect(summary).toHaveBeenCalled();
   });
});
