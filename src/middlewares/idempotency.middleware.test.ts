// Unit tests: Idempotency middleware (buy/sell retry safety)
//
// Covers the acceptance criteria:
//   - first execution stores { statusCode, body, resolvedAt } in Redis with 24-hour TTL
//   - duplicate key within TTL returns stored response without re-executing
//   - in-flight duplicate blocked up to 5 seconds then returns 409 request_in_progress
//   - in-flight duplicate returns result if resolved within wait window
//   - missing header returns 400 with missing_idempotency_key
//   - keys namespaced by wallet to prevent cross-wallet collisions
//   - expired key allows re-execution

const store = new Map<string, { value: string; ttl: number }>();

jest.mock('../utils/redis.utils', () => ({
   cacheGetRaw: jest.fn(async (key: string) => {
      const entry = store.get(key);
      return entry ? entry.value : null;
   }),
   cacheSetRaw: jest.fn(async (key: string, value: string, ttl: number) => {
      store.set(key, { value, ttl });
   }),
   cacheSetNx: jest.fn(async (key: string, value: string, ttl: number) => {
      if (store.has(key)) return false;
      store.set(key, { value, ttl });
      return true;
   }),
   cacheGetJson: jest.fn(async () => null),
   cacheSetJson: jest.fn(async () => undefined),
   cacheInvalidate: jest.fn(async (...keys: string[]) => {
      for (const k of keys) store.delete(k);
   }),
}));

import type { RequestHandler } from 'express';
import {
   buildIdempotencyCacheKey,
   IDEMPOTENCY_TTL_SECONDS,
   withIdempotency,
   idempotencyMiddleware,
} from './idempotency.middleware';

function makeRes() {
   const res: any = {};
   const finishListeners: Array<() => void> = [];
   const closeListeners: Array<() => void> = [];
   res.statusCode = 200;
   res.headersSent = false;
   res.status = jest.fn().mockImplementation((code: number) => {
      res.statusCode = code;
      return res;
   });
   res.json = jest.fn().mockImplementation((body: any) => {
      res.body = body;
      return res;
   });
   res.send = jest.fn().mockImplementation((body: any) => {
      res.body = body;
      return res;
   });
   res.__json = res.json;
   res.setHeader = jest.fn().mockReturnValue(res);
   res.set = jest.fn().mockReturnValue(res);
   res.on = jest
      .fn()
      .mockImplementation((event: string, listener: () => void) => {
         if (event === 'finish') finishListeners.push(listener);
         if (event === 'close') closeListeners.push(listener);
         return res;
      });
   res.__emitFinish = () => finishListeners.forEach(listener => listener());
   res.__emitClose = () => closeListeners.forEach(listener => listener());
   return res;
}

function makeReq(headers: Record<string, string> = {}) {
   return {
      method: 'POST',
      headers,
      params: {},
   } as never;
}

describe('withIdempotency and idempotencyMiddleware', () => {
   beforeEach(() => {
      store.clear();
      jest.clearAllMocks();
   });

   function call(
      wrapped: ReturnType<typeof withIdempotency>,
      headers: Record<string, string>
   ) {
      const req = makeReq(headers);
      const res = makeRes();
      const next = jest.fn();
      const done = wrapped(req, res as never, next);
      return { done, req, res, next };
   }

   it('returns 400 with missing_idempotency_key when the header is missing', async () => {
      const handler = jest.fn();
      const wrapped = withIdempotency(handler);

      const { res } = await Promise.resolve(call(wrapped, {}));

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.body?.error?.code).toBe('missing_idempotency_key');
      expect(handler).not.toHaveBeenCalled();
   });

   it('accepts standard Idempotency-Key header', async () => {
      const handler: RequestHandler = (_req, res) => {
         res.status(200).json({ success: true });
      };
      const wrapped = withIdempotency(handler);

      const { res, done } = call(wrapped, {
         'idempotency-key': 'valid-key-1',
         'x-wallet-address': 'GABC',
      });
      await done;
      (res as any).__emitFinish();

      expect(res.status).toHaveBeenCalledWith(200);
      expect(handler).toBeDefined();
      const key = buildIdempotencyCacheKey('GABC', 'valid-key-1');
      expect(store.has(key)).toBe(true);
   });

   it('returns 400 when the key exceeds 128 characters', async () => {
      const handler = jest.fn();
      const wrapped = withIdempotency(handler);
      const tooLong = 'k'.repeat(129);

      const { res } = await Promise.resolve(
         call(wrapped, { 'idempotency-key': tooLong })
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(handler).not.toHaveBeenCalled();
   });

   it('stores the response { statusCode, body, resolvedAt } with a 24-hour TTL after execution', async () => {
      const handler: RequestHandler = (_req, res) => {
         res.status(201).json({ ok: true });
      };
      const wrapped = withIdempotency(handler);
      const headers = { 'idempotency-key': 'op-1', 'x-wallet-address': 'GABC' };

      const { res, done } = call(wrapped, headers);
      await done;
      (res as any).__emitFinish();
      await Promise.resolve();

      const key = buildIdempotencyCacheKey('GABC', 'op-1');
      expect(store.has(key)).toBe(true);
      expect(store.get(key)?.ttl).toBe(IDEMPOTENCY_TTL_SECONDS);

      const stored = JSON.parse(store.get(key)!.value);
      expect(stored.statusCode).toBe(201);
      expect(stored.body).toEqual({ ok: true });
      expect(typeof stored.resolvedAt).toBe('string');
   });

   it('replays the cached response without re-executing the handler', async () => {
      let executions = 0;
      const handler: RequestHandler = (_req, res) => {
         executions += 1;
         res.status(200).json({ ok: true, executions });
      };
      const wrapped = withIdempotency(handler);
      const headers = {
         'idempotency-key': 'retry-1',
         'x-wallet-address': 'GABC',
      };

      // First request executes and stores.
      const first = call(wrapped, headers);
      await first.done;
      (first.res as any).__emitFinish();

      // Duplicate request replays from the store.
      const second = call(wrapped, headers);
      await second.done;

      expect(executions).toBe(1);
      expect((second.res as any).setHeader).toHaveBeenCalledWith(
         'X-Idempotent-Replay',
         'true'
      );
      expect((second.res as any).status).toHaveBeenCalledWith(200);
      expect((second.res as any).json).toHaveBeenCalledWith({
         ok: true,
         executions: 1,
      });
   });

   it('blocks in-flight duplicate and returns 409 request_in_progress when timeout is reached', async () => {
      const key = buildIdempotencyCacheKey('GABC', 'in-flight-key');
      // Mark key as in-flight
      store.set(key, {
         value: JSON.stringify({ inFlight: true, startedAt: Date.now() }),
         ttl: 60,
      });

      const handler = jest.fn();
      // Configure short timeout for test speed
      const wrapped = withIdempotency(handler, {
         waitTimeoutMs: 100,
         pollIntervalMs: 20,
      });

      const { res, done } = call(wrapped, {
         'idempotency-key': 'in-flight-key',
         'x-wallet-address': 'GABC',
      });
      await done;

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.body?.error?.code).toBe('request_in_progress');
      expect(handler).not.toHaveBeenCalled();
   });

   it('blocks in-flight duplicate and returns resolved result when first request completes within window', async () => {
      const key = buildIdempotencyCacheKey('GABC', 'in-flight-completing');
      store.set(key, {
         value: JSON.stringify({ inFlight: true, startedAt: Date.now() }),
         ttl: 60,
      });

      // Simulate first request completing after 40ms
      setTimeout(() => {
         store.set(key, {
            value: JSON.stringify({
               statusCode: 200,
               body: { completed: true },
               resolvedAt: new Date().toISOString(),
            }),
            ttl: IDEMPOTENCY_TTL_SECONDS,
         });
      }, 40);

      const handler = jest.fn();
      const wrapped = withIdempotency(handler, {
         waitTimeoutMs: 300,
         pollIntervalMs: 20,
      });

      const { res, done } = call(wrapped, {
         'idempotency-key': 'in-flight-completing',
         'x-wallet-address': 'GABC',
      });
      await done;

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.body).toEqual({ completed: true });
      expect(handler).not.toHaveBeenCalled();
   });

   it('namespaces keys by wallet to prevent cross-wallet collisions', async () => {
      let executions = 0;
      const handler: RequestHandler = (_req, res) => {
         executions += 1;
         res.status(200).json({ ok: true, executions });
      };
      const wrapped = withIdempotency(handler);

      // Wallet A uses key-1
      const callA = call(wrapped, {
         'idempotency-key': 'shared-key',
         'x-wallet-address': 'WALLET_A',
      });
      await callA.done;
      (callA.res as any).__emitFinish();

      // Wallet B uses same key-1 -> should NOT collision with Wallet A
      const callB = call(wrapped, {
         'idempotency-key': 'shared-key',
         'x-wallet-address': 'WALLET_B',
      });
      await callB.done;
      (callB.res as any).__emitFinish();

      expect(executions).toBe(2);
      expect(store.has('idempotency:WALLET_A:shared-key')).toBe(true);
      expect(store.has('idempotency:WALLET_B:shared-key')).toBe(true);
   });

   it('executes fresh when key is expired (not in store)', async () => {
      let executions = 0;
      const handler: RequestHandler = (_req, res) => {
         executions += 1;
         res.status(200).json({ ok: true, executions });
      };
      const wrapped = withIdempotency(handler);
      const headers = {
         'idempotency-key': 'expired-key',
         'x-wallet-address': 'GABC',
      };

      // First run
      const first = call(wrapped, headers);
      await first.done;
      (first.res as any).__emitFinish();
      expect(executions).toBe(1);

      // Simulate TTL expiration by deleting from store
      const key = buildIdempotencyCacheKey('GABC', 'expired-key');
      store.delete(key);

      // Second run executes fresh
      const second = call(wrapped, headers);
      await second.done;
      (second.res as any).__emitFinish();
      expect(executions).toBe(2);
   });

   it('executes fresh when the stored payload is corrupt', async () => {
      store.set(buildIdempotencyCacheKey('GABC', 'corrupt'), {
         value: 'not-json{',
         ttl: 60,
      });

      const handler: RequestHandler = (_req, res) => {
         res.status(200).json({ ok: true });
      };
      const wrapped = withIdempotency(handler);

      const { res, done } = call(wrapped, {
         'idempotency-key': 'corrupt',
         'x-wallet-address': 'GABC',
      });
      await done;

      expect((res as any).__json).toHaveBeenCalledWith({ ok: true });
   });

   it('does not cache error responses and removes in-flight lock so clients can retry cleanly', async () => {
      const handler: RequestHandler = (_req, res) => {
         res.status(500).json({ ok: false });
      };
      const wrapped = withIdempotency(handler);

      const { res, done } = call(wrapped, {
         'idempotency-key': 'boom',
         'x-wallet-address': 'GABC',
      });
      await done;
      (res as any).__emitFinish();

      expect(store.size).toBe(0);
   });

   it('works as Express middleware directly with next()', async () => {
      const middleware = idempotencyMiddleware();
      const req = makeReq({
         'idempotency-key': 'direct-mw',
         'x-wallet-address': 'GABC',
      });
      const res = makeRes();
      const next = jest.fn();

      await middleware(req, res as never, next);

      expect(next).toHaveBeenCalledTimes(1);
   });
});
