// src/middlewares/idempotency.middleware.ts
// Distributed idempotent request replay for trade endpoints (buy/sell).
//
// Key features:
// - Accepts `Idempotency-Key` (or `X-Idempotency-Key`) header.
// - Rejects requests missing the header with 400 `missing_idempotency_key`.
// - Namespaces keys by wallet address: `idempotency:{walletAddress}:{key}`.
// - On first execution: stores `{ statusCode, body, resolvedAt }` in Redis with 24h TTL.
// - On duplicate execution within TTL: returns stored response immediately without
//   touching the database or Soroban.
// - If the first request is still in-flight when a duplicate arrives, blocks for
//   up to 5 seconds and either returns the resolved response or 409 `request_in_progress`.
// - Expired keys allow fresh execution.
// - Error responses (<200 or >=400) release the in-flight lock so clients can retry.

import { Request, Response, NextFunction, RequestHandler } from 'express';
import {
   cacheGetRaw,
   cacheSetRaw,
   cacheSetNx,
   cacheInvalidate,
} from '../utils/redis.utils';
import { sendError } from '../utils/api-response.utils';
import { ErrorCode } from '../constants/error.constants';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const ALT_IDEMPOTENCY_KEY_HEADER = 'x-idempotency-key';
export const WALLET_ADDRESS_HEADER = 'x-wallet-address';
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
/** Stored responses expire after 24 hours (spec). */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
export const DEFAULT_IN_FLIGHT_TIMEOUT_MS = 5000;
export const DEFAULT_IN_FLIGHT_POLL_INTERVAL_MS = 50;
export const IN_FLIGHT_LOCK_TTL_SECONDS = 60;

const REDIS_KEY_PREFIX = 'idempotency';

export interface StoredIdempotentResponse {
   statusCode: number;
   status?: number;
   body: unknown;
   resolvedAt: string;
   inFlight?: boolean;
}

export interface IdempotencyOptions {
   waitTimeoutMs?: number;
   pollIntervalMs?: number;
}

function readHeader(req: Request, name: string): string | undefined {
   const raw = req.headers[name];
   const value = Array.isArray(raw) ? raw[0] : raw;
   return typeof value === 'string' ? value.trim() : undefined;
}

export function extractWalletAddress(req: Request): string {
   return (
      (req as any).walletAddress ||
      readHeader(req, WALLET_ADDRESS_HEADER) ||
      readHeader(req, 'wallet-address') ||
      (req as any).user?.walletAddress ||
      ''
   );
}

export function buildIdempotencyCacheKey(
   wallet: string,
   idempotencyKey: string
): string {
   const normalizedWallet = wallet ? wallet.trim() : '';
   return `${REDIS_KEY_PREFIX}:${normalizedWallet}:${idempotencyKey}`;
}

function sleep(ms: number): Promise<void> {
   return new Promise(resolve => setTimeout(resolve, ms));
}

async function safeSetNx(
   key: string,
   value: string,
   ttlSeconds: number
): Promise<boolean> {
   if (typeof cacheSetNx === 'function') {
      try {
         return await cacheSetNx(key, value, ttlSeconds);
      } catch {
         return false;
      }
   }
   const existing = await cacheGetRaw(key);
   if (existing !== null) return false;
   await cacheSetRaw(key, value, ttlSeconds);
   return true;
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
      readHeader(req, ALT_IDEMPOTENCY_KEY_HEADER);

   if (!key) {
      sendError(
         res,
         400,
         ErrorCode.MISSING_IDEMPOTENCY_KEY,
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
   const raw = await cacheGetRaw(
      buildIdempotencyCacheKey(wallet, idempotencyKey)
   );
   if (raw === null) return false;

   try {
      const stored = JSON.parse(raw) as StoredIdempotentResponse;
      if (stored.inFlight) return false;
      const statusCode = stored.statusCode ?? stored.status ?? 200;
      res.setHeader('X-Idempotent-Replay', 'true');
      res.setHeader('Content-Type', 'application/json');
      res.status(statusCode).json(stored.body);
      return true;
   } catch {
      // Corrupt entry: ignore it and let the handler execute fresh.
      return false;
   }
}

/**
 * Express middleware providing distributed idempotency protection.
 * Can be plugged directly into route chains:
 *
 *   router.post('/buy', idempotencyMiddleware(), httpBuyKey);
 */
export function idempotencyMiddleware(
   options?: IdempotencyOptions
): RequestHandler {
   const waitTimeoutMs = options?.waitTimeoutMs ?? DEFAULT_IN_FLIGHT_TIMEOUT_MS;
   const pollIntervalMs =
      options?.pollIntervalMs ?? DEFAULT_IN_FLIGHT_POLL_INTERVAL_MS;

   return async (req: Request, res: Response, next: NextFunction) => {
      const idempotencyKey = validateIdempotencyHeader(req, res);
      if (!idempotencyKey) return;

      const wallet = extractWalletAddress(req);
      const cacheKey = buildIdempotencyCacheKey(wallet, idempotencyKey);

      // Check if an existing completed response is already in Redis
      const existingRaw = await cacheGetRaw(cacheKey);
      if (existingRaw !== null) {
         try {
            const parsed = JSON.parse(existingRaw) as StoredIdempotentResponse;
            if (
               !parsed.inFlight &&
               (parsed.statusCode !== undefined || parsed.status !== undefined)
            ) {
               const statusCode = parsed.statusCode ?? parsed.status ?? 200;
               res.setHeader('X-Idempotent-Replay', 'true');
               res.setHeader('Content-Type', 'application/json');
               res.status(statusCode).json(parsed.body);
               return;
            }
         } catch {
            // Corrupt entry: remove it and let the handler execute fresh
            await cacheInvalidate(cacheKey);
         }
      }

      // Try acquiring the in-flight lock atomically
      const inFlightPayload = JSON.stringify({
         inFlight: true,
         startedAt: Date.now(),
      });
      const acquired = await safeSetNx(
         cacheKey,
         inFlightPayload,
         IN_FLIGHT_LOCK_TTL_SECONDS
      );

      if (!acquired) {
         // Another request is in-flight or just finished. Block up to waitTimeoutMs.
         const pollStart = Date.now();
         let resolved: StoredIdempotentResponse | null = null;
         while (Date.now() - pollStart < waitTimeoutMs) {
            await sleep(pollIntervalMs);
            const pollRaw = await cacheGetRaw(cacheKey);
            if (pollRaw) {
               try {
                  const pollParsed = JSON.parse(
                     pollRaw
                  ) as StoredIdempotentResponse;
                  if (
                     !pollParsed.inFlight &&
                     (pollParsed.statusCode !== undefined ||
                        pollParsed.status !== undefined)
                  ) {
                     resolved = pollParsed;
                     break;
                  }
               } catch {
                  // Ignore corrupt
               }
            }
         }

         if (resolved) {
            const statusCode = resolved.statusCode ?? resolved.status ?? 200;
            res.setHeader('X-Idempotent-Replay', 'true');
            res.setHeader('Content-Type', 'application/json');
            res.status(statusCode).json(resolved.body);
            return;
         }

         sendError(
            res,
            409,
            ErrorCode.REQUEST_IN_PROGRESS,
            'A request with this idempotency key is currently in progress'
         );
         return;
      }

      // First request acquired in-flight lock. Intercept response to store on success.
      const state: { captured: StoredIdempotentResponse | null } = {
         captured: null,
      };
      const originalJson =
         typeof res.json === 'function' ? res.json.bind(res) : undefined;
      const originalSend =
         typeof res.send === 'function' ? res.send.bind(res) : undefined;

      const captureAndStore = (body: unknown) => {
         if (!state.captured && res.statusCode >= 200 && res.statusCode < 400) {
            state.captured = {
               statusCode: res.statusCode,
               status: res.statusCode,
               body,
               resolvedAt: new Date().toISOString(),
            };
            void cacheSetRaw(
               cacheKey,
               JSON.stringify(state.captured),
               IDEMPOTENCY_TTL_SECONDS
            );
         }
      };

      if (originalJson) {
         res.json = ((body: unknown) => {
            captureAndStore(body);
            return originalJson(body);
         }) as typeof res.json;
      }

      if (originalSend) {
         res.send = ((body: unknown) => {
            let parsedBody = body;
            if (typeof body === 'string') {
               try {
                  parsedBody = JSON.parse(body);
               } catch {
                  parsedBody = body;
               }
            }
            captureAndStore(parsedBody);
            return originalSend(body);
         }) as typeof res.send;
      }

      res.on('finish', () => {
         if (state.captured) {
            void cacheSetRaw(
               cacheKey,
               JSON.stringify(state.captured),
               IDEMPOTENCY_TTL_SECONDS
            );
         } else {
            // Failed execution (>= 400): remove the in-flight lock so retries are clean
            void cacheInvalidate(cacheKey);
         }
      });

      res.on('close', () => {
         if (!res.writableEnded && !state.captured) {
            void cacheInvalidate(cacheKey);
         }
      });

      next();
   };
}

/**
 * Wrap a request handler with idempotent-replay semantics keyed by the
 * `Idempotency-Key` header and caller wallet address.
 */
export function withIdempotency(
   handler: RequestHandler,
   options?: IdempotencyOptions
): RequestHandler {
   const middleware = idempotencyMiddleware(options);
   return async (req: Request, res: Response, next: NextFunction) => {
      let nextCalled = false;
      let nextError: unknown = undefined;
      await middleware(req, res, ((err?: unknown) => {
         nextCalled = true;
         nextError = err;
      }) as NextFunction);

      if (nextError) {
         return next(nextError);
      }
      if (nextCalled) {
         try {
            return await Promise.resolve(handler(req, res, next));
         } catch (error) {
            const idempotencyKey =
               readHeader(req, IDEMPOTENCY_KEY_HEADER) ??
               readHeader(req, ALT_IDEMPOTENCY_KEY_HEADER);
            if (idempotencyKey) {
               const wallet = extractWalletAddress(req);
               void cacheInvalidate(
                  buildIdempotencyCacheKey(wallet, idempotencyKey)
               );
            }
            throw error;
         }
      }
   };
}
