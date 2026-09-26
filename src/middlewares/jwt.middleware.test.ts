import jwt from 'jsonwebtoken';
import { jwtAuth, JwtPayload } from './jwt.middleware';
import { logger } from '../utils/logger.utils';
import { envConfig } from '../config';

jest.mock('../utils/logger.utils', () => ({
   logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

const TEST_PAYLOAD: JwtPayload = {
   walletAddress: 'GTESTWALLET',
   sub: 'user-1',
};

function makeReq(overrides: Record<string, unknown> = {}): any {
   return {
      headers: {},
      path: '/api/v1/creators/me',
      socket: { remoteAddress: '203.0.113.42' },
      ...overrides,
   };
}

function makeRes(): any {
   const res: any = {};
   res.status = jest.fn().mockReturnValue(res);
   res.json = jest.fn().mockReturnValue(res);
   res.setHeader = jest.fn().mockReturnValue(res);
   return res;
}

function signValidToken(): string {
   return jwt.sign(TEST_PAYLOAD, envConfig.JWT_SECRET, { expiresIn: '1h' });
}

function signExpiredToken(secondsAgo: number): string {
   // Sign a token that already expired `secondsAgo` seconds in the past by
   // backdating iat/exp directly rather than waiting on a real clock.
   const now = Math.floor(Date.now() / 1000);
   return jwt.sign(
      { ...TEST_PAYLOAD, iat: now - secondsAgo - 10, exp: now - secondsAgo },
      envConfig.JWT_SECRET
   );
}

describe('jwtAuth — structured rejection logging (#767)', () => {
   beforeEach(() => jest.clearAllMocks());

   describe('missing token', () => {
      it('emits a warn log with reason missing_token when the header is absent', () => {
         const next = jest.fn();
         jwtAuth(makeReq(), makeRes(), next);

         expect(logger.warn).toHaveBeenCalledTimes(1);
         const log = (logger.warn as jest.Mock).mock.calls[0][0];
         expect(log.reason).toBe('missing_token');
         expect(next).not.toHaveBeenCalled();
      });

      it('emits missing_token when the header does not start with "Bearer "', () => {
         const next = jest.fn();
         jwtAuth(
            makeReq({ headers: { authorization: 'Basic abc123' } }),
            makeRes(),
            next
         );

         const log = (logger.warn as jest.Mock).mock.calls[0][0];
         expect(log.reason).toBe('missing_token');
      });

      it('includes endpoint and ip_address', () => {
         jwtAuth(
            makeReq({
               path: '/api/v1/payouts',
               socket: { remoteAddress: '198.51.100.7' },
            }),
            makeRes(),
            jest.fn()
         );

         const log = (logger.warn as jest.Mock).mock.calls[0][0];
         expect(log.endpoint).toBe('/api/v1/payouts');
         expect(log.ip_address).toBe('198.51.100.7');
      });

      it('responds 401 without calling next', () => {
         const next = jest.fn();
         const res = makeRes();
         jwtAuth(makeReq(), res, next);

         expect(res.status).toHaveBeenCalledWith(401);
         expect(next).not.toHaveBeenCalled();
      });
   });

   describe('invalid signature', () => {
      it('emits a warn log with reason invalid_signature for a token signed with the wrong secret', () => {
         const badToken = jwt.sign(
            TEST_PAYLOAD,
            'a-completely-different-secret-value',
            {
               expiresIn: '1h',
            }
         );
         const next = jest.fn();
         jwtAuth(
            makeReq({ headers: { authorization: `Bearer ${badToken}` } }),
            makeRes(),
            next
         );

         expect(logger.warn).toHaveBeenCalledTimes(1);
         const log = (logger.warn as jest.Mock).mock.calls[0][0];
         expect(log.reason).toBe('invalid_signature');
         expect(next).not.toHaveBeenCalled();
      });

      it('emits invalid_signature for a malformed token string', () => {
         jwtAuth(
            makeReq({ headers: { authorization: 'Bearer not-a-real-jwt' } }),
            makeRes(),
            jest.fn()
         );

         const log = (logger.warn as jest.Mock).mock.calls[0][0];
         expect(log.reason).toBe('invalid_signature');
      });

      it('includes endpoint and ip_address', () => {
         const badToken = jwt.sign(TEST_PAYLOAD, 'wrong-secret', {
            expiresIn: '1h',
         });
         jwtAuth(
            makeReq({
               headers: { authorization: `Bearer ${badToken}` },
               path: '/api/v1/wallets/link',
               socket: { remoteAddress: '198.51.100.9' },
            }),
            makeRes(),
            jest.fn()
         );

         const log = (logger.warn as jest.Mock).mock.calls[0][0];
         expect(log.endpoint).toBe('/api/v1/wallets/link');
         expect(log.ip_address).toBe('198.51.100.9');
      });
   });

   describe('expired token', () => {
      it('emits a warn log with reason expired_token and expired_seconds_ago', () => {
         const expiredToken = signExpiredToken(120);
         const next = jest.fn();
         jwtAuth(
            makeReq({ headers: { authorization: `Bearer ${expiredToken}` } }),
            makeRes(),
            next
         );

         expect(logger.warn).toHaveBeenCalledTimes(1);
         const log = (logger.warn as jest.Mock).mock.calls[0][0];
         expect(log.reason).toBe('expired_token');
         // Allow a small tolerance for test execution time.
         expect(log.expired_seconds_ago).toBeGreaterThanOrEqual(119);
         expect(log.expired_seconds_ago).toBeLessThanOrEqual(122);
         expect(next).not.toHaveBeenCalled();
      });

      it('includes endpoint and ip_address', () => {
         const expiredToken = signExpiredToken(30);
         jwtAuth(
            makeReq({
               headers: { authorization: `Bearer ${expiredToken}` },
               path: '/api/v1/notifications',
               socket: { remoteAddress: '198.51.100.11' },
            }),
            makeRes(),
            jest.fn()
         );

         const log = (logger.warn as jest.Mock).mock.calls[0][0];
         expect(log.endpoint).toBe('/api/v1/notifications');
         expect(log.ip_address).toBe('198.51.100.11');
      });

      it('does not log expired_seconds_ago for invalid_signature or missing_token rejections', () => {
         jwtAuth(makeReq(), makeRes(), jest.fn());
         expect((logger.warn as jest.Mock).mock.calls[0][0]).not.toHaveProperty(
            'expired_seconds_ago'
         );

         jest.clearAllMocks();
         const badToken = jwt.sign(TEST_PAYLOAD, 'wrong-secret', {
            expiresIn: '1h',
         });
         jwtAuth(
            makeReq({ headers: { authorization: `Bearer ${badToken}` } }),
            makeRes(),
            jest.fn()
         );
         expect((logger.warn as jest.Mock).mock.calls[0][0]).not.toHaveProperty(
            'expired_seconds_ago'
         );
      });
   });

   describe('valid token', () => {
      it('does not log and calls next', () => {
         const next = jest.fn();
         const validToken = signValidToken();
         jwtAuth(
            makeReq({ headers: { authorization: `Bearer ${validToken}` } }),
            makeRes(),
            next
         );

         expect(logger.warn).not.toHaveBeenCalled();
         expect(next).toHaveBeenCalledTimes(1);
      });

      it('attaches jwtPayload to the request', () => {
         const req = makeReq({
            headers: { authorization: `Bearer ${signValidToken()}` },
         });
         jwtAuth(req, makeRes(), jest.fn());

         expect(req.jwtPayload).toMatchObject(TEST_PAYLOAD);
      });
   });
});
