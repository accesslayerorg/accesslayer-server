// src/middlewares/platform-pause.middleware.ts
// Trade validation middleware for platform-wide and per-key pauses (#988).
//
// Mounted ahead of every trade handler (buy, sell, multi-buy). During a
// platform pause every trade is rejected with 503; per-key pauses are checked
// independently so only the paused key's trades are blocked.

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ErrorCode } from '../constants/error.constants';
import { sendError } from '../utils/api-response.utils';
import {
   getCachedKeyPauseState,
   getPlatformPauseState,
   isKeyPaused,
} from '../modules/platform/platform-pause.service';

export const PLATFORM_PAUSED_MESSAGE =
   'Trading is paused platform-wide; requests are rejected until it resumes';

export const KEY_PAUSED_MESSAGE =
   'Trading is paused for this key; requests are rejected until it resumes';

/** Thrown by the imperative assert helpers below. */
export class PlatformPausedError extends Error {
   constructor(public readonly pausedAt: string | null) {
      super(PLATFORM_PAUSED_MESSAGE);
      this.name = 'PlatformPausedError';
   }
}

export class KeyPausedError extends Error {
   constructor(public readonly keyId: string) {
      super(KEY_PAUSED_MESSAGE);
      this.name = 'KeyPausedError';
   }
}

/** Throws when the platform is paused. */
export async function assertPlatformNotPaused(): Promise<void> {
   const state = await getPlatformPauseState();
   if (state.paused) {
      throw new PlatformPausedError(state.pausedAt);
   }
}

/** Throws when any of the supplied keys is paused. */
export async function assertKeysNotPaused(keyIds: string[]): Promise<void> {
   for (const keyId of keyIds) {
      if (await isKeyPaused(keyId)) {
         throw new KeyPausedError(keyId);
      }
   }
}

/**
 * Collects the key identifiers a trade request targets: URL params (`:id`,
 * `:keyId`, `:creatorId`) plus multi-buy style `body.legs[].creator`.
 */
export function resolveTradeKeyIds(req: Request): string[] {
   const ids = new Set<string>();

   const params = (req.params ?? {}) as Record<string, unknown>;
   for (const field of ['id', 'keyId', 'creatorId']) {
      const value = params[field];
      if (typeof value === 'string' && value.length > 0) {
         ids.add(value);
      } else if (Array.isArray(value)) {
         for (const entry of value) {
            if (typeof entry === 'string' && entry.length > 0) {
               ids.add(entry);
            }
         }
      }
   }

   const body = (req.body ?? {}) as Record<string, unknown>;
   if (Array.isArray(body.legs)) {
      for (const leg of body.legs as Array<Record<string, unknown>>) {
         const value = leg?.creator ?? leg?.creatorId ?? leg?.keyId;
         if (typeof value === 'string' && value.length > 0) {
            ids.add(value);
         }
      }
   }
   for (const field of ['creator', 'creatorId', 'keyId']) {
      const value = body[field];
      if (typeof value === 'string' && value.length > 0) {
         ids.add(value);
      }
   }

   return [...ids];
}

/**
 * Express middleware that rejects a trade request while the platform (or any
 * targeted key) is paused. Sends `503 Service Unavailable` with a pause
 * message; otherwise defers to the next handler.
 */
export function platformPauseGuard(): RequestHandler {
   return async (req: Request, res: Response, next: NextFunction) => {
      try {
         const platform = await getPlatformPauseState();
         if (platform.paused) {
            sendError(
               res,
               503,
               ErrorCode.SERVICE_UNAVAILABLE,
               PLATFORM_PAUSED_MESSAGE,
               [
                  {
                     field: 'pausedAt',
                     message: platform.pausedAt ?? 'unknown',
                  },
                  ...(platform.actor
                     ? [{ field: 'actor', message: platform.actor }]
                     : []),
               ]
            );
            return;
         }

         for (const keyId of resolveTradeKeyIds(req)) {
            const cached = await getCachedKeyPauseState(keyId);
            const paused = cached ? cached.paused : await isKeyPaused(keyId);
            if (paused) {
               sendError(
                  res,
                  503,
                  ErrorCode.SERVICE_UNAVAILABLE,
                  KEY_PAUSED_MESSAGE,
                  [
                     { field: 'keyId', message: keyId },
                     ...(cached?.pausedAt
                        ? [{ field: 'pausedAt', message: cached.pausedAt }]
                        : []),
                  ]
               );
               return;
            }
         }

         next();
      } catch (error) {
         next(error);
      }
   };
}
