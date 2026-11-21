// Unit tests: Distributed idempotency middleware (buy/sell retry safety #725)
//
// Covers the acceptance criteria:
//   - duplicate request with same key returns the cached response
//   - cached response returned without re-executing the handler
//   - Redis entry stored with a 24-hour TTL with { statusCode, body, resolvedAt }
//   - missing header returns 400 missing_idempotency_key
//   - in-flight duplicate blocked then returns 409 request_in_progress
//   - in-flight duplicate resolves when first request completes within window
//   - keys namespaced by wallet address to prevent cross-wallet collisions
//   - key exceeding 128 characters returns 400

const store = new Map<string, { value: string; ttl: number }>();

jest.mock('../utils/redis.utils', () => ({
   cacheGetRaw: jest.fn(async (key: string) => {
      const entry = store.get(key);
      return entry ? entry.value : null;
   }),
   cacheSetRaw: jest.fn(async (key: string, value: string, ttl: number) => {
      store.set(key, { value, ttl });
   }),
   cacheSetRawNx: jest.fn(async (key: string, value: string, ttl: number) => {
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
   idempotencyMiddleware,
   withIdempotency,
} from './idempotency.middleware';

function makeRes() {
   const res: any = {};
   const finishListeners: Array<() => void> = [];
   res.statusCode = 200;
   res.headersSent = false;
   res.status = jest.fn().mockImplementation((code: number) => {
      res.statusCode = code;
      return res;
   });
   res.json = jest.fn().mockReturnValue(res);
   res.send = jest.fn().mockReturnValue(res);
   res.__json = res.json;
   res.__send = res.send;
   res.setHeader = jest.fn().mockReturnValue(res);
   res.set = jest.fn().mockReturnValue(res);
   res.on = jest
      .fn()
      .mockImplementation((event: string, listener: () => void) => {
         if (event === 'finish') finishListeners.push(listener);
         return res;
      });
   res.__emitFinish = () => finishListeners.forEach(listener => listener());
   return res;
}

function makeReq(headers: Record<string, string> = {}) {
   return {
      method: 'POST',
      headers,
      params: {},
   } as never;
}

describe('withIdempotency', () => {
   beforeEach(() => {
      store.clear();
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

   it('returns 400 with missing_idempotency_key when header is missing', async () => {
      const handler = jest.fn();
      const wrapped = withIdempotency(handler);

      const { res } = await Promise.resolve(call(wrapped, {}));

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
         expect.objectContaining({
            error: expect.objectContaining({
               code: 'missing_idempotency_key',
            }),
         })
      );
      expect(handler).not.toHaveBeenCalled();
   });

   it('accepts standard Idempotency-Key header without x- prefix', async () => {
      const handler: RequestHandler = (_req, res) => {
         res.status(200).json({ ok: true });
      };
      const wrapped = withIdempotency(handler);

      const { res, done } = call(wrapped, {
         'idempotency-key': 'std-key-1',
         'x-wallet-address': 'GABC',
      });
      await done;
      (res as any).__emitFinish();

      expect(res.status).not.toHaveBeenCalledWith(400);
      expect(store.has(buildIdempotencyCacheKey('GABC', 'std-key-1'))).toBe(
         true
      );
   });

   it('returns 400 when the key exceeds 128 characters', async () => {
      const handler = jest.fn();
      const wrapped = withIdempotency(handler);
      const tooLong = 'k'.repeat(129);

      const { res } = await Promise.resolve(
         call(wrapped, { 'x-idempotency-key': tooLong })
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(handler).not.toHaveBeenCalled();
   });

   it('stores the response with a 24-hour TTL after execution with statusCode and resolvedAt', async () => {
      const handler: RequestHandler = (_req, res) => {
         res.status(201).json({ ok: true });
      };
      const wrapped = withIdempotency(handler);
      const headers = {
         'x-idempotency-key': 'op-1',
         'x-wallet-address': 'GABC',
      };

      const { res, done } = call(wrapped, headers);
      await done;
      (res as any).__emitFinish();
      await Promise.resolve();

      const key = buildIdempotencyCacheKey('GABC', 'op-1');
      expect(store.has(key)).toBe(true);
      expect(store.get(key)?.ttl).toBe(IDEMPOTENCY_TTL_SECONDS);

      const stored = JSON.parse(store.get(key)!.value);
      expect(stored).toMatchObject({
         statusCode: 201,
         status: 201,
         body: { ok: true },
      });
      expect(typeof stored.resolvedAt).toBe('string');
      expect(new Date(stored.resolvedAt).getTime()).not.toBeNaN();
   });

   it('replays the cached response without re-executing the handler', async () => {
      let executions = 0;
      const handler: RequestHandler = (_req, res) => {
         executions += 1;
         res.status(200).json({ ok: true, executions });
      };
      const wrapped = withIdempotency(handler);
      const headers = {
         'x-idempotency-key': 'retry-1',
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

   it('returns 409 request_in_progress when in-flight duplicate times out', async () => {
      const key = buildIdempotencyCacheKey('GABC', 'in-flight-key');
      store.set(key, {
         value: JSON.stringify({ inProgress: true, startedAt: Date.now() }),
         ttl: 60,
      });

      const handler = jest.fn();
      const wrapped = withIdempotency(handler, {
         timeoutMs: 100,
         pollIntervalMs: 20,
      });

      const { res, done } = call(wrapped, {
         'idempotency-key': 'in-flight-key',
         'x-wallet-address': 'GABC',
      });
      await done;

      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(
         expect.objectContaining({
            error: expect.objectContaining({
               code: 'request_in_progress',
            }),
         })
      );
      expect(handler).not.toHaveBeenCalled();
   });

   it('unblocks and returns result when in-flight request resolves within timeout', async () => {
      const key = buildIdempotencyCacheKey('GABC', 'resolving-key');
      store.set(key, {
         value: JSON.stringify({ inProgress: true, startedAt: Date.now() }),
         ttl: 60,
      });

      // Simulate the first request resolving after 60ms
      setTimeout(() => {
         store.set(key, {
            value: JSON.stringify({
               statusCode: 200,
               body: { ok: true, inFlightResolved: true },
               resolvedAt: new Date().toISOString(),
            }),
            ttl: IDEMPOTENCY_TTL_SECONDS,
         });
      }, 50);

      const handler = jest.fn();
      const wrapped = withIdempotency(handler, {
         timeoutMs: 500,
         pollIntervalMs: 20,
      });

      const { res, done } = call(wrapped, {
         'idempotency-key': 'resolving-key',
         'x-wallet-address': 'GABC',
      });
      await done;

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
         ok: true,
         inFlightResolved: true,
      });
      expect((res as any).setHeader).toHaveBeenCalledWith(
         'X-Idempotent-Replay',
         'true'
      );
      expect(handler).not.toHaveBeenCalled();
   });

   it('namespaces keys by wallet to prevent cross-wallet collisions', async () => {
      let executions = 0;
      const handler: RequestHandler = (req, res) => {
         executions += 1;
         res.status(200).json({
            ok: true,
            wallet: (req.headers as any)['x-wallet-address'],
         });
      };
      const wrapped = withIdempotency(handler);

      // Wallet 1 executes
      const first = call(wrapped, {
         'idempotency-key': 'shared-key',
         'x-wallet-address': 'GWALLET1',
      });
      await first.done;
      (first.res as any).__emitFinish();

      // Wallet 2 executes with the same key
      const second = call(wrapped, {
         'idempotency-key': 'shared-key',
         'x-wallet-address': 'GWALLET2',
      });
      await second.done;
      (second.res as any).__emitFinish();

      expect(executions).toBe(2);
      expect(
         store.has(buildIdempotencyCacheKey('GWALLET1', 'shared-key'))
      ).toBe(true);
      expect(
         store.has(buildIdempotencyCacheKey('GWALLET2', 'shared-key'))
      ).toBe(true);
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
         'x-idempotency-key': 'corrupt',
         'x-wallet-address': 'GABC',
      });
      await done;

      expect((res as any).__json).toHaveBeenCalledWith({ ok: true });
   });

   it('does not cache error responses so clients can retry cleanly', async () => {
      const handler: RequestHandler = (_req, res) => {
         res.status(500).json({ ok: false });
      };
      const wrapped = withIdempotency(handler);

      const { res, done } = call(wrapped, {
         'x-idempotency-key': 'boom',
         'x-wallet-address': 'GABC',
      });
      await done;
      (res as any).__emitFinish();

      expect(store.size).toBe(0);
   });
});

describe('idempotencyMiddleware', () => {
   beforeEach(() => {
      store.clear();
   });

   it('works as Express route middleware calling next() on first execution', async () => {
      const middleware = idempotencyMiddleware();
      const req = makeReq({
         'idempotency-key': 'middleware-key-1',
         'x-wallet-address': 'GABC',
      });
      const res = makeRes();
      const next = jest.fn();

      await middleware(req, res as never, next);

      expect(next).toHaveBeenCalledTimes(1);
      res.status(200).json({ step: 'done' });
      res.__emitFinish();

      const key = buildIdempotencyCacheKey('GABC', 'middleware-key-1');
      expect(store.has(key)).toBe(true);
   });
});
