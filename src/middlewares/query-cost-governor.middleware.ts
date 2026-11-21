// src/middlewares/query-cost-governor.middleware.ts
// Adaptive per-wallet (or per-IP, when unauthenticated) database query cost
// governor (#755).
//
// A single wallet firing expensive paginated/search/analytics queries can
// saturate the connection pool for everyone. This assigns a cost unit to
// every request (see src/utils/query-cost.utils.ts), tracks a rolling sum
// of costs per caller in a Redis sorted set, and rejects requests that would
// push the caller over budget with 429 query_budget_exceeded.
//
// Identity: most of the routes this is meant to protect (creator list,
// holders, search) are public reads with no wallet-auth middleware in front
// of them today, so "per-wallet" only applies when the caller sent a valid
// JWT (the same one requireJwtAuth checks) — decoded here without rejecting
// when absent/invalid, unlike requireJwtAuth. Anonymous callers still get a
// real budget, keyed on IP, so the governor actually protects the public
// routes named in the issue rather than only the already-authenticated ones.
//
// Concurrency note: like wallet-rate-limit.middleware.ts, this evicts/reads
// then conditionally writes in separate round trips rather than a single
// atomic Lua script — under a burst of truly concurrent requests from the
// same caller there's a small window where more than the budget could be
// admitted. Matches this codebase's existing accepted tradeoff for Redis
// rate limiting rather than introducing a different rigor level for this
// one feature.

import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { getRedis } from '../utils/redis.utils';
import { envConfig } from '../config';
import { logger } from '../utils/logger.utils';
import { extractBearerToken, verifyWalletAccessToken } from '../utils/jwt.utils';
import {
   buildQueryCostRedisKey,
   compileCostMap,
   computeQueryCost,
   matchCostRoute,
   type CompiledCostRoute,
} from '../utils/query-cost.utils';
import { QUERY_COST_EXEMPT_PATH_PREFIXES } from '../constants/query-cost.constants';

const INTERNAL_SERVICE_HEADER = 'x-internal-service-key';

export interface QueryCostRequest extends Request {
   walletAddress?: string;
   queryCost?: { cost: number; identity: string };
}

function isInternalServiceCall(req: Request): boolean {
   if (!envConfig.INTERNAL_SERVICE_KEY) return false;
   const provided = req.headers[INTERNAL_SERVICE_HEADER];
   const value = Array.isArray(provided) ? provided[0] : provided;
   return value === envConfig.INTERNAL_SERVICE_KEY;
}

function isExemptPath(path: string): boolean {
   return QUERY_COST_EXEMPT_PATH_PREFIXES.some(prefix =>
      path.startsWith(prefix)
   );
}

/** Best-effort wallet resolution: never rejects on a missing/invalid token. */
function resolveWalletAddress(req: Request): string | undefined {
   const token = extractBearerToken(req.headers.authorization);
   if (!token) return undefined;
   try {
      return verifyWalletAccessToken(token).wallet;
   } catch {
      return undefined;
   }
}

function parseAdminWallets(raw: string | undefined): Set<string> {
   if (!raw) return new Set();
   return new Set(
      raw
         .split(',')
         .map(wallet => wallet.trim().toLowerCase())
         .filter(Boolean)
   );
}

/** Encodes a sorted-set member as "<cost>:<uuid>" so cost survives eviction/summation without a second data structure. */
function encodeMember(cost: number): string {
   return `${cost}:${randomUUID()}`;
}

function decodeCost(member: string): number {
   const separator = member.indexOf(':');
   const cost = Number.parseInt(
      separator === -1 ? member : member.slice(0, separator),
      10
   );
   return Number.isFinite(cost) ? cost : 0;
}

export interface QueryCostGovernorOptions {
   /** Rolling window in milliseconds. Defaults to envConfig.QUERY_COST_WINDOW_MS. */
   windowMs?: number;
   /** Budget per window. Defaults to envConfig.QUERY_COST_BUDGET. */
   budget?: number;
}

export function queryCostGovernor(options: QueryCostGovernorOptions = {}) {
   const windowMs = options.windowMs ?? envConfig.QUERY_COST_WINDOW_MS;
   const budget = options.budget ?? envConfig.QUERY_COST_BUDGET;
   const adminWallets = parseAdminWallets(envConfig.QUERY_COST_ADMIN_WALLETS);

   let compiledRoutes: CompiledCostRoute[];
   try {
      compiledRoutes = compileCostMap(envConfig.QUERY_COST_MAP_JSON);
   } catch (error) {
      logger.error(
         { type: 'query_cost_config_invalid', error },
         'Invalid QUERY_COST_MAP_JSON; falling back to defaults'
      );
      compiledRoutes = compileCostMap(undefined);
   }

   return async (
      req: QueryCostRequest,
      res: Response,
      next: NextFunction
   ): Promise<void> => {
      if (isExemptPath(req.path) || isInternalServiceCall(req)) {
         next();
         return;
      }

      const walletAddress = resolveWalletAddress(req);
      req.walletAddress = walletAddress;

      if (walletAddress && adminWallets.has(walletAddress.toLowerCase())) {
         next();
         return;
      }

      const identity = walletAddress
         ? `wallet:${walletAddress}`
         : `ip:${req.ip ?? 'unknown'}`;

      const matched = matchCostRoute(compiledRoutes, req.method, req.path);
      const cost = computeQueryCost(matched, req.query.limit);

      const redis = getRedis();
      if (!redis) {
         // Fail open, same as wallet-rate-limit.middleware.ts: caching/rate
         // infra being down must never take the API down.
         req.queryCost = { cost, identity };
         res.set('X-Query-Cost', String(cost));
         next();
         return;
      }

      const key = buildQueryCostRedisKey(identity);
      const now = Date.now();
      const windowStart = now - windowMs;

      try {
         await redis.zremrangebyscore(key, 0, windowStart);
         const members = await redis.zrange(key, 0, '-1');
         const spent = members.reduce(
            (sum, member) => sum + decodeCost(member),
            0
         );

         if (spent + cost > budget) {
            const oldest = await redis.zrange(key, 0, '0', 'WITHSCORES');
            const oldestTimestamp = oldest[1] ? Number(oldest[1]) : now;
            const resetAtMs = oldestTimestamp + windowMs;
            const retryAfterSeconds = Math.max(
               1,
               Math.ceil((resetAtMs - now) / 1000)
            );

            logger.warn(
               {
                  type: 'query_budget_exceeded',
                  identity,
                  route: req.path,
                  method: req.method,
                  cost,
                  spent,
                  budget,
               },
               'Query budget exceeded'
            );

            res
               .status(429)
               .set('Retry-After', String(retryAfterSeconds))
               .set('X-Query-Cost', String(cost))
               .set('X-Query-Budget-Remaining', String(Math.max(0, budget - spent)))
               .set('X-Query-Budget-Reset', String(Math.floor(resetAtMs / 1000)))
               .json({
                  type: 'query_budget_exceeded',
                  message: 'Query budget exceeded for this window.',
                  retryAfterSeconds,
                  timestamp: new Date().toISOString(),
               });
            return;
         }

         await redis.zadd(key, now, encodeMember(cost));
         await redis.pexpire(key, windowMs);

         req.queryCost = { cost, identity };
         res.set('X-Query-Cost', String(cost));
         res.set(
            'X-Query-Budget-Remaining',
            String(Math.max(0, budget - spent - cost))
         );
         next();
      } catch (error) {
         logger.error(
            { error, identity, route: req.path },
            'Query cost governor check failed; allowing request through (fail open)'
         );
         res.set('X-Query-Cost', String(cost));
         next();
      }
   };
}
