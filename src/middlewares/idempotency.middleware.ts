// src/middlewares/idempotency.middleware.ts
// Distributed idempotency layer backed by Redis for buy/sell trade endpoints.
// Prevents double-execution across concurrent retries (#725).
//
// Usage:
//   router.post('/keys/:keyId/buy', idempotencyMiddleware(), httpBuyKey);
//   // Or wrapping a handler:
//   router.post('/keys/:keyId/buy', withIdempotency(httpBuyKey));
//
// Behaviour:
// - `Idempotency-Key` (or `X-Idempotency-Key`) header required; 400 missing_idempotency_key when missing.
// - 400 BAD_REQUEST when exceeding 128 characters.
// - Namespaces keys by wallet address: `idempotency:{walletAddress}:{key}`.
// - On first request: atomically claims the in-flight lock, executes transaction, and stores
//   `{ statusCode, body, resolvedAt }` in Redis with a 24-hour TTL.
// - On duplicate request (same key within TTL): returns the stored response immediately
//   without touching the database or Soroban.
// - If first request is still in-flight when duplicate arrives: blocks duplicate for up to
//   5 seconds, then either returns the resolved result or a 409 request_in_progress.
// - Failures (status >= 400 or unhandled error) clear the in-flight key so clients can retry cleanly.

import { Request, Response, NextFunction, RequestHandler } from 'express';
import {
   cacheGetRaw,
   cacheSetRaw,
   cacheSetRawNx,
   cacheInvalidate,
} from '../utils/redis.utils';
import { ErrorCode, sendError } from '../utils/api-response.utils';
import type { StellarSignedRequest } from './stellar-signature.middleware';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const X_IDEMPOTENCY_KEY_HEADER = 'x-idempotency-key';
export const WALLET_ADDRESS_HEADER = 'x-wallet-address';
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** Stored responses expire after 24 hours (spec). */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** In-flight lock expiry: 60s safety TTL in case of unhandled crash. */
export const IN_FLIGHT_TTL_SECONDS = 60;

/** Default max time (5s) for a concurrent duplicate to block waiting for in-flight request. */
export const IN_FLIGHT_TIMEOUT_MS = 5000;

/** Polling interval when waiting for an in-flight duplicate to resolve. */
export const IN_FLIGHT_POLL_INTERVAL_MS = 100;

const REDIS_KEY_PREFIX = 'idempotency';

export interface StoredIdempotentResponse {
   statusCode: number;
   status?: number;
   body: unknown;
   resolvedAt: string;
   inProgress?: boolean;
}

export interface IdempotencyOptions {
   timeoutMs?: number;
   pollIntervalMs?: number;
   inFlightTtlSeconds?: number;
   ttlSeconds?: number;
}

function sleep(ms: number): Promise<void> {
   return new Promise(resolve => setTimeout(resolve, ms));
}

export function readHeader(req: Request, name: string): string | undefined {
   const lower = name.toLowerCase();
   const raw = req.headers[lower] ?? req.headers[name];
   const value = Array.isArray(raw) ? raw[0] : raw;
   return typeof value === 'string' ? value.trim() : undefined;
}

export function getCallerWallet(req: Request): string {
   const signedReq = req as StellarSignedRequest;
   if (signedReq.walletAddress) return signedReq.walletAddress;
   const headerWallet = readHeader(req, WALLET_ADDRESS_HEADER);
   if (headerWallet) return headerWallet;
   const userWallet = (req as any).user?.wallet;
   if (typeof userWallet === 'string' && userWallet.trim())
      return userWallet.trim();
   const directWallet = (req as any).wallet;
   if (typeof directWallet === 'string' && directWallet.trim())
      return directWallet.trim();
   return '';
}

export function buildIdempotencyCacheKey(
   wallet: string,
   idempotencyKey: string
): string {
   return `${REDIS_KEY_PREFIX}:${wallet || ''}:${idempotencyKey}`;
}

/**
 * Validate the idempotency header. Returns the validated key or null after
 * sending an error response (400).
 */
export function validateIdempotencyHeader(
   req: Request,
   res: Response
): string | null {
   const key =
      readHeader(req, IDEMPOTENCY_KEY_HEADER) ||
      readHeader(req, X_IDEMPOTENCY_KEY_HEADER);

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
      if (
         stored.inProgress ||
         (stored.statusCode === undefined && stored.status === undefined)
      ) {
         return false;
      }
      res.setHeader('X-Idempotent-Replay', 'true');
      res.setHeader('Content-Type', 'application/json');
      res.status(stored.statusCode ?? stored.status ?? 200).json(stored.body);
      return true;
   } catch {
      // Corrupt entry: ignore it and let the handler execute fresh.
      return false;
   }
}

async function setNx(
   key: string,
   value: string,
   ttlSeconds: number
): Promise<boolean> {
   if (typeof cacheSetRawNx === 'function') {
      return cacheSetRawNx(key, value, ttlSeconds);
   }
   const existing = await cacheGetRaw(key);
   if (existing !== null) return false;
   await cacheSetRaw(key, value, ttlSeconds);
   return true;
}

/**
 * Distributed idempotency middleware for route chains.
 */
export function idempotencyMiddleware(
   options?: IdempotencyOptions
): RequestHandler {
   const timeoutMs = options?.timeoutMs ?? IN_FLIGHT_TIMEOUT_MS;
   const pollIntervalMs = options?.pollIntervalMs ?? IN_FLIGHT_POLL_INTERVAL_MS;
   const inFlightTtl = options?.inFlightTtlSeconds ?? IN_FLIGHT_TTL_SECONDS;
   const ttlSeconds = options?.ttlSeconds ?? IDEMPOTENCY_TTL_SECONDS;

   return async (
      req: Request,
      res: Response,
      next: NextFunction
   ): Promise<void> => {
      const idempotencyKey = validateIdempotencyHeader(req, res);
      if (!idempotencyKey) return;

      const wallet = getCallerWallet(req);
      const key = buildIdempotencyCacheKey(wallet, idempotencyKey);

      const inFlightPayload = JSON.stringify({
         inProgress: true,
         startedAt: Date.now(),
      });

      let acquired = await setNx(key, inFlightPayload, inFlightTtl);

      if (!acquired) {
         // Key already exists. Check if it's already completed or corrupt.
         const existingRaw = await cacheGetRaw(key);
         if (existingRaw !== null) {
            try {
               const parsed = JSON.parse(
                  existingRaw
               ) as StoredIdempotentResponse;
               if (
                  !parsed.inProgress &&
                  (parsed.statusCode !== undefined ||
                     parsed.status !== undefined)
               ) {
                  // Duplicate request within TTL: return stored response immediately
                  res.setHeader('X-Idempotent-Replay', 'true');
                  res.setHeader('Content-Type', 'application/json');
                  res.status(parsed.statusCode ?? parsed.status ?? 200).json(
                     parsed.body
                  );
                  return;
               }
            } catch {
               // Corrupt entry: clear it and acquire lock fresh
               await cacheInvalidate(key);
               acquired = await setNx(key, inFlightPayload, inFlightTtl);
            }
         }
      }

      if (!acquired) {
         // The first request is currently in-flight. Block duplicate for up to timeoutMs (5s).
         const startTime = Date.now();
         let resolvedEntry: StoredIdempotentResponse | null = null;

         while (Date.now() - startTime < timeoutMs) {
            await sleep(pollIntervalMs);
            const currentRaw = await cacheGetRaw(key);
            if (!currentRaw) {
               // First request failed or was cleared
               break;
            }
            try {
               const parsed = JSON.parse(
                  currentRaw
               ) as StoredIdempotentResponse;
               if (
                  !parsed.inProgress &&
                  (parsed.statusCode !== undefined ||
                     parsed.status !== undefined)
               ) {
                  resolvedEntry = parsed;
                  break;
               }
            } catch {
               break;
            }
         }

         if (resolvedEntry) {
            res.setHeader('X-Idempotent-Replay', 'true');
            res.setHeader('Content-Type', 'application/json');
            res.status(
               resolvedEntry.statusCode ?? resolvedEntry.status ?? 200
            ).json(resolvedEntry.body);
            return;
         }

         // In-flight duplicate blocked up to timeoutMs then returns 409 request_in_progress
         sendError(
            res,
            409,
            ErrorCode.REQUEST_IN_PROGRESS,
            'A request with this idempotency key is currently in progress.'
         );
         return;
      }

      // First execution: acquired in-flight lock
      let capturedBody: unknown = undefined;
      let persisted = false;

      const persistResult = async (statusCode: number, body: unknown) => {
         if (persisted) return;
         persisted = true;
         if (statusCode < 400) {
            const entry: StoredIdempotentResponse = {
               statusCode,
               status: statusCode,
               body,
               resolvedAt: new Date().toISOString(),
            };
            await cacheSetRaw(key, JSON.stringify(entry), ttlSeconds);
         } else {
            await cacheInvalidate(key);
         }
      };

      const originalJson =
         typeof res.json === 'function' ? res.json.bind(res) : undefined;
      const originalSend =
         typeof res.send === 'function' ? res.send.bind(res) : undefined;

      if (originalJson) {
         res.json = ((body: unknown) => {
            capturedBody = body;
            void persistResult(res.statusCode, body);
            return originalJson(body);
         }) as typeof res.json;
      }

      if (originalSend) {
         res.send = ((body: unknown) => {
            if (capturedBody === undefined) {
               try {
                  capturedBody =
                     typeof body === 'string' ? JSON.parse(body) : body;
               } catch {
                  capturedBody = body;
               }
            }
            void persistResult(res.statusCode, capturedBody);
            return originalSend(body);
         }) as typeof res.send;
      }

      res.on('finish', () => {
         if (!persisted) {
            void persistResult(res.statusCode, capturedBody);
         }
      });

      res.on('close', () => {
         if (!res.writableEnded && !persisted) {
            void cacheInvalidate(key);
         }
      });

      try {
         await Promise.resolve(next());
      } catch (err) {
         void cacheInvalidate(key);
         throw err;
      }
   };
}

/**
 * Wrap a request handler with idempotent-replay semantics keyed by the
 * `Idempotency-Key` (or `X-Idempotency-Key`) header and caller wallet address.
 */
export function withIdempotency(
   handler: RequestHandler,
   options?: IdempotencyOptions
): RequestHandler {
   const middleware = idempotencyMiddleware(options);
   return async (
      req: Request,
      res: Response,
      next: NextFunction
   ): Promise<void> => {
      await middleware(req, res, () => handler(req, res, next));
   };
}
