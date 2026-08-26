// src/modules/analytics/analytics.controller.test.ts
// Authorization and caching behavior for GET /creator/:keyId/analytics.

jest.mock('../../utils/prisma.utils', () => ({
   prisma: { creatorProfile: { findUnique: jest.fn() } },
}));

jest.mock('./analytics.cache', () => ({
   getCachedAnalytics: jest.fn(async () => null),
   setCachedAnalytics: jest.fn(async () => undefined),
}));

jest.mock('./analytics.service', () => ({
   getCreatorKeyWallet: jest.fn(),
   getKeyAnalytics: jest.fn(async () => ({ keyId: 'k1', points: [] })),
}));

import { httpGetKeyAnalytics } from './analytics.controller';
import { getCreatorKeyWallet } from './analytics.service';

const getWallet = getCreatorKeyWallet as jest.Mock;

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

describe('httpGetKeyAnalytics', () => {
   afterEach(() => jest.clearAllMocks());

   it('returns 403 when the JWT wallet is not the key creator', async () => {
      getWallet.mockResolvedValue('creatorWallet');
      const req: any = { params: { keyId: 'k1' }, authWallet: 'otherWallet' };
      const res = makeRes();

      await httpGetKeyAnalytics(req, res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(403);
   });

   it('returns 200 with data when the JWT wallet is the creator', async () => {
      getWallet.mockResolvedValue('creatorWallet');
      const req: any = { params: { keyId: 'k1' }, authWallet: 'creatorWallet' };
      const res = makeRes();

      await httpGetKeyAnalytics(req, res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.body.data.keyId).toBe('k1');
   });
});
