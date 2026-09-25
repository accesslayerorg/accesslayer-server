// src/middlewares/idempotency.middleware.ts
// Idempotent request replay for trade endpoints (buy/sell).
//
// Wrap a mutation handler with {@link withIdempotency} and clients may safely
// retry after timeouts:
//
//   router.post('/keys/:keyId/buy', withIdempotency(httpBuyKey));
//
// Behaviour:
// - `Idempotency-Key` header required; the legacy `X-Idempotency-Key` spelling
//   is still accepted. Requests return 400 when the key is missing or longer than 128
//   characters.
// - Responses are stored in Redis under `idempotency:{wallet}:{key}` with a
//   24-hour TTL, where `{wallet}` comes from the `x-wallet-address` header.
// - Duplicate requests within the TTL receive the stored response verbatim
//   and the wrapped handler never executes.
// - Only successful responses (2xx) are cached; failures are not, so
//   clients can retry cleanly.

import { Request, Response, NextFunction, RequestHandler } from 'express';
import { cacheGetRaw, cacheSetRaw } from '../utils/redis.utils';
import { ErrorCode, sendError } from '../utils/api-response.utils';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const LEGACY_IDEMPOTENCY_KEY_HEADER = 'x-idempotency-key';
export const WALLET_ADDRESS_HEADER = 'x-wallet-address';
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
/** Stored responses expire after 24 hours (spec). */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

const REDIS_KEY_PREFIX = 'idempotency';

interface StoredIdempotentResponse {
   status: number;
   body: unknown;
}

function readHeader(req: Request, name: string): string | undefined {
   const raw = req.headers[name];
   const value = Array.isArray(raw) ? raw[0] : raw;
   return typeof value === 'string' ? value.trim() : undefined;
}

export function buildIdempotencyCacheKey(
   wallet: string,
   idempotencyKey: string
): string {
   return `${REDIS_KEY_PREFIX}:${wallet.toLowerCase()}:${idempotencyKey}`;
}

/**
 * Validate the idempotency header. Returns the validated key or null after
 * sending a 400 response.
 */
export function validateIdempotencyHeader(
   req: Request,
   res: Response
): string | null {
   const key =
      readHeader(req, IDEMPOTENCY_KEY_HEADER) ??
      readHeader(req, LEGACY_IDEMPOTENCY_KEY_HEADER);

   if (!key) {
      sendError(
         res,
         400,
         ErrorCode.BAD_REQUEST,
         `Missing ${IDEMPOTENCY_KEY_HEADER} header. Send a unique key per logical operation to enable safe retries.`
      );
      return null;
   }

   if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
      sendError(
         res,
         400,
         ErrorCode.BAD_REQUEST,
         `${IDEMPOTENCY_KEY_HEADER} must not exceed ${IDEMPOTENCY_KEY_MAX_LENGTH} characters.`
      );
      return null;
   }

   return key;
}

/**
 * Replay a stored response for `(wallet, idempotencyKey)` when present.
 * Returns true when a cached response was sent.
 */
export async function tryReplayIdempotentResponse(
   _req: Request,
   res: Response,
   wallet: string,
   idempotencyKey: string
): Promise<boolean> {
   const raw = await cacheGetRaw(buildIdempotencyCacheKey(wallet, idempotencyKey));
   if (raw === null) return false;

   try {
      const stored = JSON.parse(raw) as StoredIdempotentResponse;
      res.setHeader('X-Idempotent-Replay', 'true');
      res.setHeader('Content-Type', 'application/json');
      res.status(stored.status).json(stored.body);
      return true;
   } catch {
      // Corrupt entry: ignore it and let the handler execute fresh.
      return false;
   }
}

/**
 * Wrap a request handler with idempotent-replay semantics keyed by the
 * `Idempotency-Key` header and caller wallet address.
 */
export function withIdempotency(handler: RequestHandler): RequestHandler {
   return async (req: Request, res: Response, next: NextFunction) => {
      const idempotencyKey = validateIdempotencyHeader(req, res);
      if (!idempotencyKey) return;

      const wallet = readHeader(req, WALLET_ADDRESS_HEADER) ?? '';

      if (await tryReplayIdempotentResponse(req, res, wallet, idempotencyKey)) {
         return;
      }

      const state: { captured: StoredIdempotentResponse | null } = {
         captured: null,
      };
      const originalJson = res.json.bind(res);

      res.json = ((body: unknown) => {
         // Only successful executions are cached so clients can retry
         // cleanly after server-side failures.
         if (!state.captured && res.statusCode < 400) {
            state.captured = { status: res.statusCode, body };
         }
         return originalJson(body);
      }) as typeof res.json;

      res.on('finish', () => {
         if (!state.captured) return;
         void cacheSetRaw(
            buildIdempotencyCacheKey(wallet, idempotencyKey),
            JSON.stringify(state.captured),
            IDEMPOTENCY_TTL_SECONDS
         );
      });

      await Promise.resolve(handler(req, res, next));
   };
}
