// Unit tests for the adaptive query cost governor (#755).

const mockEnvConfig: {
   INTERNAL_SERVICE_KEY?: string;
   QUERY_COST_BUDGET: number;
   QUERY_COST_WINDOW_MS: number;
   QUERY_COST_MAP_JSON?: string;
   QUERY_COST_ADMIN_WALLETS?: string;
} = {
   INTERNAL_SERVICE_KEY: undefined,
   QUERY_COST_BUDGET: 200,
   QUERY_COST_WINDOW_MS: 60_000,
   QUERY_COST_MAP_JSON: undefined,
   QUERY_COST_ADMIN_WALLETS: undefined,
};

jest.mock('../config', () => ({
   envConfig: mockEnvConfig,
}));

jest.mock('../utils/logger.utils', () => ({
   logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

function buildFakeRedis() {
   const store = new Map<string, Array<{ score: number; member: string }>>();

   return {
      zremrangebyscore: jest.fn(async (key: string, _min: number, max: number) => {
         const entries = store.get(key) ?? [];
         store.set(
            key,
            entries.filter(entry => entry.score > max)
         );
      }),
      zrange: jest.fn(async (key: string, _start: number, _stop: number, withScores?: string) => {
         const entries = (store.get(key) ?? []).sort((a, b) => a.score - b.score);
         if (withScores === 'WITHSCORES') {
            const first = entries[0];
            return first ? [first.member, String(first.score)] : [];
         }
         return entries.map(entry => entry.member);
      }),
      zadd: jest.fn(async (key: string, score: number, member: string) => {
         const entries = store.get(key) ?? [];
         entries.push({ score, member });
         store.set(key, entries);
      }),
      pexpire: jest.fn(async () => 1),
      del: jest.fn(async (key: string) => {
         store.delete(key);
      }),
      __store: store,
   };
}

jest.mock('../utils/redis.utils', () => ({
   getRedis: jest.fn(),
}));

const mockVerifyWalletAccessToken = jest.fn();
jest.mock('../utils/jwt.utils', () => ({
   extractBearerToken: (header: unknown) =>
      typeof header === 'string' && header.startsWith('Bearer ')
         ? header.slice(7)
         : undefined,
   verifyWalletAccessToken: (token: string) => mockVerifyWalletAccessToken(token),
}));

import { getRedis } from '../utils/redis.utils';
import { queryCostGovernor } from './query-cost-governor.middleware';

const mockGetRedis = getRedis as jest.Mock;

function makeReq(overrides: Partial<Record<string, unknown>> = {}): any {
   return {
      method: 'GET',
      path: '/creators',
      query: {},
      headers: {},
      ip: '203.0.113.5',
      ...overrides,
   };
}

function makeRes(): any {
   const res: any = {};
   res.status = jest.fn().mockReturnValue(res);
   res.json = jest.fn().mockReturnValue(res);
   res.set = jest.fn().mockReturnValue(res);
   return res;
}

describe('queryCostGovernor', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockEnvConfig.INTERNAL_SERVICE_KEY = undefined;
      mockEnvConfig.QUERY_COST_BUDGET = 200;
      mockEnvConfig.QUERY_COST_WINDOW_MS = 60_000;
      mockEnvConfig.QUERY_COST_MAP_JSON = undefined;
      mockEnvConfig.QUERY_COST_ADMIN_WALLETS = undefined;
      mockVerifyWalletAccessToken.mockReset();
   });

   it('admits requests summing to exactly the budget, keyed per IP when unauthenticated', async () => {
      const redis = buildFakeRedis();
      mockGetRedis.mockReturnValue(redis);
      mockEnvConfig.QUERY_COST_BUDGET = 10;
      const governor = queryCostGovernor();

      // 10 requests at cost 1 (GET /creators) = exactly the budget.
      for (let i = 0; i < 10; i++) {
         const req = makeReq();
         const res = makeRes();
         const next = jest.fn();
         await governor(req, res, next);
         expect(next).toHaveBeenCalledTimes(1);
         expect(res.status).not.toHaveBeenCalled();
      }
   });

   it('throttles the request that pushes total cost over budget, with Retry-After and reset headers', async () => {
      const redis = buildFakeRedis();
      mockGetRedis.mockReturnValue(redis);
      mockEnvConfig.QUERY_COST_BUDGET = 5;
      const governor = queryCostGovernor();

      // GET /creators/:id/holders costs 3 by default.
      for (let i = 0; i < 1; i++) {
         const req = makeReq({ path: '/creators/abc/holders' });
         const res = makeRes();
         await governor(req, res, jest.fn());
      }

      const req = makeReq({ path: '/creators/abc/holders' });
      const res = makeRes();
      const next = jest.fn();
      await governor(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
      expect(res.set).toHaveBeenCalledWith(
         'X-Query-Budget-Reset',
         expect.any(String)
      );
      const body = res.json.mock.calls[0][0];
      expect(body.type).toBe('query_budget_exceeded');
   });

   it('sets X-Query-Cost and X-Query-Budget-Remaining on successful responses', async () => {
      const redis = buildFakeRedis();
      mockGetRedis.mockReturnValue(redis);
      const governor = queryCostGovernor();

      const req = makeReq({ path: '/creators/abc/holders' });
      const res = makeRes();
      await governor(req, res, jest.fn());

      expect(res.set).toHaveBeenCalledWith('X-Query-Cost', '3');
      expect(res.set).toHaveBeenCalledWith(
         'X-Query-Budget-Remaining',
         String(mockEnvConfig.QUERY_COST_BUDGET - 3)
      );
   });

   it('multiplies cost by the limit query param', async () => {
      const redis = buildFakeRedis();
      mockGetRedis.mockReturnValue(redis);
      const governor = queryCostGovernor();

      const req = makeReq({ path: '/creators/abc/holders', query: { limit: '10' } });
      const res = makeRes();
      await governor(req, res, jest.fn());

      expect(res.set).toHaveBeenCalledWith('X-Query-Cost', '30');
   });

   it('allows requests again after the rolling window expires', async () => {
      const redis = buildFakeRedis();
      mockGetRedis.mockReturnValue(redis);
      mockEnvConfig.QUERY_COST_BUDGET = 1;
      mockEnvConfig.QUERY_COST_WINDOW_MS = 50;
      const governor = queryCostGovernor();

      const first = makeReq();
      await governor(first, makeRes(), jest.fn());

      const blocked = makeReq();
      const blockedRes = makeRes();
      const blockedNext = jest.fn();
      await governor(blocked, blockedRes, blockedNext);
      expect(blockedNext).not.toHaveBeenCalled();

      await new Promise(resolve => setTimeout(resolve, 60));

      const afterWindow = makeReq();
      const afterRes = makeRes();
      const afterNext = jest.fn();
      await governor(afterWindow, afterRes, afterNext);
      expect(afterNext).toHaveBeenCalledTimes(1);
   });

   it('bypasses the governor entirely for admin wallets', async () => {
      const redis = buildFakeRedis();
      mockGetRedis.mockReturnValue(redis);
      mockEnvConfig.QUERY_COST_BUDGET = 1;
      mockEnvConfig.QUERY_COST_ADMIN_WALLETS = 'GADMIN123, GOTHER456';
      mockVerifyWalletAccessToken.mockReturnValue({ wallet: 'GADMIN123' });
      const governor = queryCostGovernor();

      for (let i = 0; i < 5; i++) {
         const req = makeReq({
            path: '/creators/abc/holders',
            headers: { authorization: 'Bearer admin-token' },
         });
         const res = makeRes();
         const next = jest.fn();
         await governor(req, res, next);
         expect(next).toHaveBeenCalledTimes(1);
         expect(res.status).not.toHaveBeenCalled();
      }
   });

   it('bypasses the governor for internal service calls', async () => {
      const redis = buildFakeRedis();
      mockGetRedis.mockReturnValue(redis);
      mockEnvConfig.QUERY_COST_BUDGET = 0;
      mockEnvConfig.INTERNAL_SERVICE_KEY = 'internal-secret';
      const governor = queryCostGovernor();

      const req = makeReq({ headers: { 'x-internal-service-key': 'internal-secret' } });
      const res = makeRes();
      const next = jest.fn();
      await governor(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
   });

   it('exempts /health and its own /internal/qcost routes', async () => {
      const redis = buildFakeRedis();
      mockGetRedis.mockReturnValue(redis);
      mockEnvConfig.QUERY_COST_BUDGET = 0;
      const governor = queryCostGovernor();

      for (const path of ['/health', '/internal/qcost/reset/GABC']) {
         const req = makeReq({ path, method: 'POST' });
         const res = makeRes();
         const next = jest.fn();
         await governor(req, res, next);
         expect(next).toHaveBeenCalledTimes(1);
         expect(res.status).not.toHaveBeenCalled();
      }
   });

   it('fails open when Redis is unavailable', async () => {
      mockGetRedis.mockReturnValue(null);
      mockEnvConfig.QUERY_COST_BUDGET = 0;
      const governor = queryCostGovernor();

      const req = makeReq();
      const res = makeRes();
      const next = jest.fn();
      await governor(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
   });

   it('fails open when a Redis command throws', async () => {
      const redis = buildFakeRedis();
      redis.zremrangebyscore.mockRejectedValueOnce(new Error('connection reset'));
      mockGetRedis.mockReturnValue(redis);
      const governor = queryCostGovernor();

      const req = makeReq();
      const res = makeRes();
      const next = jest.fn();
      await governor(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
   });
});
