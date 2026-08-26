// src/middlewares/idempotency.middleware.test.ts
// Unit tests for the idempotency middleware.

const redisGet = jest.fn();
const redisSet = jest.fn().mockResolvedValue(undefined);

jest.mock('../utils/redis.utils', () => ({
   getRedisClient: jest.fn(async () => ({
      get: redisGet,
      set: redisSet,
   })),
}));

import { idempotencyMiddleware } from './idempotency.middleware';

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

function makeReq(overrides: Record<string, unknown> = {}) {
   return {
      headers: {},
      body: {},
      ...overrides,
   } as any;
}

describe('idempotencyMiddleware', () => {
   afterEach(() => jest.clearAllMocks());

   it('returns 400 when the header is missing', async () => {
      const req = makeReq();
      const res = makeRes();
      const next = jest.fn();

      await idempotencyMiddleware()(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
   });

   it('returns 400 when the key exceeds 128 characters', async () => {
      const req = makeReq({ headers: { 'x-idempotency-key': 'x'.repeat(129) } });
      const res = makeRes();
      const next = jest.fn();

      await idempotencyMiddleware()(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
   });

   it('returns the cached response without calling next', async () => {
      redisGet.mockResolvedValue(
         JSON.stringify({ statusCode: 200, body: { ok: true } })
      );
      const req = makeReq({ headers: { 'x-idempotency-key': 'key1' } });
      const res = makeRes();
      const next = jest.fn();

      await idempotencyMiddleware()(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.body).toEqual({ ok: true });
   });

   it('stores the response in Redis with a 24h TTL after execution', async () => {
      redisGet.mockResolvedValue(null);
      const req = makeReq({ headers: { 'x-idempotency-key': 'key1' } });
      const res = makeRes();
      const next = jest.fn();

      await idempotencyMiddleware()(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);

      // Simulate the handler sending a response.
      res.status(201);
      res.json({ created: true });

      expect(redisSet).toHaveBeenCalledTimes(1);
      const [key, value, opts] = redisSet.mock.calls[0];
      expect(key).toContain('key1');
      expect(opts).toEqual({ EX: 24 * 60 * 60 });
      expect(JSON.parse(value)).toEqual({
         statusCode: 201,
         body: { created: true },
      });
   });

   it('keys the cache by the authenticated wallet', async () => {
      redisGet.mockResolvedValue(null);
      const req = makeReq({
         headers: { 'x-idempotency-key': 'key1' },
         authWallet: 'WALLET1',
      });
      const res = makeRes();
      const next = jest.fn();

      await idempotencyMiddleware()(req, res, next);
      res.json({ ok: 1 });

      expect(redisSet.mock.calls[0][0]).toContain('WALLET1');
   });
});
