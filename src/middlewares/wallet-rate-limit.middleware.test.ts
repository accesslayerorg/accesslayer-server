// Unit tests for the per-wallet sliding-window rate limiter (#779).

const mockEnvConfig: { INTERNAL_SERVICE_KEY?: string } = {
   INTERNAL_SERVICE_KEY: undefined,
};

jest.mock('../config', () => ({
   envConfig: mockEnvConfig,
}));

jest.mock('../utils/logger.utils', () => ({
   logger: {
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
      info: jest.fn(),
   },
}));

type PipelineCommand = [string, ...unknown[]];

function buildFakeRedis(initialCount = 0) {
   const commands: PipelineCommand[] = [];
   let currentCount = initialCount;

   const pipeline = {
      zremrangebyscore: (...args: unknown[]) => {
         commands.push(['zremrangebyscore', ...args]);
         return pipeline;
      },
      zadd: (...args: unknown[]) => {
         commands.push(['zadd', ...args]);
         currentCount += 1;
         return pipeline;
      },
      zcard: (...args: unknown[]) => {
         commands.push(['zcard', ...args]);
         return pipeline;
      },
      pexpire: (...args: unknown[]) => {
         commands.push(['pexpire', ...args]);
         return pipeline;
      },
      exec: jest.fn(async () => [
         [null, 0], // zremrangebyscore
         [null, 1], // zadd
         [null, currentCount], // zcard
         [null, 1], // pexpire
      ]),
   };

   return {
      pipeline: jest.fn(() => pipeline),
      __setCount: (n: number) => {
         currentCount = n;
      },
   };
}

jest.mock('../utils/redis.utils', () => ({
   getRedis: jest.fn(),
}));

import { getRedis } from '../utils/redis.utils';
import { walletRateLimit } from './wallet-rate-limit.middleware';
import type { StellarSignedRequest } from './stellar-signature.middleware';

const mockGetRedis = getRedis as jest.Mock;

function makeReq(walletAddress?: string, headers: Record<string, string> = {}) {
   return {
      walletAddress,
      headers,
      path: '/api/v1/creators/creator-1/buy',
   } as unknown as StellarSignedRequest;
}

function makeRes(): any {
   const res: any = {};
   res.status = jest.fn().mockReturnValue(res);
   res.json = jest.fn().mockReturnValue(res);
   res.set = jest.fn().mockReturnValue(res);
   return res;
}

describe('walletRateLimit', () => {
   beforeEach(() => {
      mockEnvConfig.INTERNAL_SERVICE_KEY = undefined;
      jest.clearAllMocks();
   });

   it('allows the request when the wallet is under the limit', async () => {
      const fakeRedis = buildFakeRedis(3);
      mockGetRedis.mockReturnValue(fakeRedis);
      const middleware = walletRateLimit({
         windowMs: 10_000,
         max: 5,
         keyPrefix: 'rl:test:',
      });

      const req = makeReq('GBUYER');
      const res = makeRes();
      const next = jest.fn();
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
   });

   it('returns 429 with Retry-After when the wallet exceeds the limit', async () => {
      const fakeRedis = buildFakeRedis(6);
      mockGetRedis.mockReturnValue(fakeRedis);
      const middleware = walletRateLimit({
         windowMs: 10_000,
         max: 5,
         keyPrefix: 'rl:test:',
      });

      const req = makeReq('GBUYER');
      const res = makeRes();
      const next = jest.fn();
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.set).toHaveBeenCalledWith('Retry-After', '10');
      const body = res.json.mock.calls[0][0];
      expect(body.type).toBe('RATE_LIMIT_EXCEEDED');
   });

   it('passes through unlimited when no wallet address is set (unauthenticated)', async () => {
      const fakeRedis = buildFakeRedis(999);
      mockGetRedis.mockReturnValue(fakeRedis);
      const middleware = walletRateLimit({
         windowMs: 10_000,
         max: 5,
         keyPrefix: 'rl:test:',
      });

      const req = makeReq(undefined);
      const res = makeRes();
      const next = jest.fn();
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(fakeRedis.pipeline).not.toHaveBeenCalled();
   });

   it('bypasses the limit for internal service calls with a matching key', async () => {
      mockEnvConfig.INTERNAL_SERVICE_KEY = 'super-secret';
      const fakeRedis = buildFakeRedis(999);
      mockGetRedis.mockReturnValue(fakeRedis);
      const middleware = walletRateLimit({
         windowMs: 10_000,
         max: 5,
         keyPrefix: 'rl:test:',
      });

      const req = makeReq('GBUYER', { 'x-internal-service-key': 'super-secret' });
      const res = makeRes();
      const next = jest.fn();
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(fakeRedis.pipeline).not.toHaveBeenCalled();
   });

   it('does not bypass the limit when the internal service key header is wrong', async () => {
      mockEnvConfig.INTERNAL_SERVICE_KEY = 'super-secret';
      const fakeRedis = buildFakeRedis(6);
      mockGetRedis.mockReturnValue(fakeRedis);
      const middleware = walletRateLimit({
         windowMs: 10_000,
         max: 5,
         keyPrefix: 'rl:test:',
      });

      const req = makeReq('GBUYER', { 'x-internal-service-key': 'wrong' });
      const res = makeRes();
      const next = jest.fn();
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(429);
   });

   it('fails open (allows the request) when Redis throws', async () => {
      mockGetRedis.mockReturnValue({
         pipeline: () => ({
            zremrangebyscore: () => {
               throw new Error('redis down');
            },
         }),
      });
      const middleware = walletRateLimit({
         windowMs: 10_000,
         max: 5,
         keyPrefix: 'rl:test:',
      });

      const req = makeReq('GBUYER');
      const res = makeRes();
      const next = jest.fn();
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
   });
});

describe('walletRateLimit with JWT-authenticated requests (#1226)', () => {
   beforeEach(() => {
      mockEnvConfig.INTERNAL_SERVICE_KEY = undefined;
      jest.clearAllMocks();
   });

   function makeJwtReq(wallet: string) {
      return {
         user: { wallet },
         headers: {},
         path: '/api/v1/keys/key-1/reports',
      } as unknown as StellarSignedRequest;
   }

   it('keys the limit on req.user.wallet when walletAddress is absent', async () => {
      const fakeRedis = buildFakeRedis(6);
      mockGetRedis.mockReturnValue(fakeRedis);
      const middleware = walletRateLimit({
         windowMs: 3_600_000,
         max: 5,
         keyPrefix: 'rl:key-report:',
      });

      const res = makeRes();
      const next = jest.fn();
      await middleware(makeJwtReq('GREPORTER'), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.set).toHaveBeenCalledWith('Retry-After', '3600');
      const pipeline = fakeRedis.pipeline.mock.results[0].value;
      expect(pipeline.exec).toHaveBeenCalled();
   });

   it('uses the rl:key-report:<wallet> Redis key', async () => {
      const fakeRedis = buildFakeRedis(0);
      const zcardSpy = jest.fn();
      mockGetRedis.mockReturnValue(fakeRedis);
      const middleware = walletRateLimit({
         windowMs: 3_600_000,
         max: 5,
         keyPrefix: 'rl:key-report:',
      });

      const next = jest.fn();
      const pipeline = fakeRedis.pipeline();
      const originalZcard = pipeline.zcard;
      pipeline.zcard = (...args: unknown[]) => {
         zcardSpy(...args);
         return originalZcard(...args);
      };
      await middleware(makeJwtReq('GREPORTER'), makeRes(), next);

      expect(next).toHaveBeenCalled();
      expect(zcardSpy).toHaveBeenCalledWith('rl:key-report:GREPORTER');
   });
});
