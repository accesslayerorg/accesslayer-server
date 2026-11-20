import jwt from 'jsonwebtoken';
import { adminGuard } from './admin-guard.middleware';
import { logger } from '../utils/logger.utils';
import { envConfig } from '../config';

jest.mock('../utils/logger.utils', () => ({
   logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

function makeReq(token?: string): any {
   return {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      path: '/api/v1/admin/creators',
      socket: { remoteAddress: '203.0.113.7' },
   };
}

function makeRes(): any {
   const res: any = {};
   res.status = jest.fn().mockReturnValue(res);
   res.json = jest.fn().mockReturnValue(res);
   res.setHeader = jest.fn().mockReturnValue(res);
   return res;
}

describe('adminGuard — expired token logging (#733)', () => {
   beforeEach(() => jest.clearAllMocks());

   it('logs one expired_token warning with the admin id and responds 401', () => {
      const now = Math.floor(Date.now() / 1000);
      const token = jwt.sign(
         { sub: 'admin-1', role: 'admin', iat: now - 100, exp: now - 90 },
         envConfig.JWT_SECRET
      );
      const res = makeRes();
      const next = jest.fn();

      adminGuard(makeReq(token), res, next);

      expect(logger.warn).toHaveBeenCalledTimes(1);
      const log = (logger.warn as jest.Mock).mock.calls[0][0];
      expect(log).toMatchObject({
         reason: 'expired_token',
         wallet: 'admin-1',
         endpoint: '/api/v1/admin/creators',
         ip_address: '203.0.113.7',
      });
      expect(log.expired_seconds_ago).toBeGreaterThan(0);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
   });

   it('does not log an expired_token warning for a bad signature or a missing token', () => {
      adminGuard(makeReq(jwt.sign({ sub: 'x' }, 'wrong-secret')), makeRes(), jest.fn());
      adminGuard(makeReq(), makeRes(), jest.fn());

      expect(logger.warn).not.toHaveBeenCalled();
   });
});
