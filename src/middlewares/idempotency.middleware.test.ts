// Unit tests: X-Idempotency-Key replay middleware (buy/sell retry safety)
//
// Covers the acceptance criteria:
//   - duplicate request with same key returns the cached response
//   - cached response returned without re-executing the handler
//   - Redis entry stored with a 24-hour TTL
//   - missing header returns 400
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
   cacheGetJson: jest.fn(async () => null),
   cacheSetJson: jest.fn(async () => undefined),
   cacheInvalidate: jest.fn(async () => undefined),
}));

import type { RequestHandler } from 'express';
import {
   buildIdempotencyCacheKey,
   IDEMPOTENCY_TTL_SECONDS,
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
   // The middleware rebinds res.json; keep the raw mock for assertions.
   res.__json = res.json;
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

   it('returns 400 when the header is missing and skips the handler', async () => {
      const handler = jest.fn();
      const wrapped = withIdempotency(handler);

      const { res } = await Promise.resolve(call(wrapped, {}));

      expect(res.status).toHaveBeenCalledWith(400);
      expect(handler).not.toHaveBeenCalled();
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

   it('stores the response with a 24-hour TTL after execution', async () => {
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
      expect(JSON.parse(store.get(key)!.value)).toEqual({
         status: 201,
         body: { ok: true },
      });
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
