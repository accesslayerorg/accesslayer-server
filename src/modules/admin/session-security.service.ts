// src/modules/admin/session-security.service.ts
// Session activity logging + anomaly detection for security monitoring (#1035).
//
// Every authenticated request is recorded in `session_activity` (wallet, IP,
// user agent, endpoint, status, timestamp) by session-activity.middleware.ts.
// Three anomaly rules run against each new entry and raise rows in
// `security_flags` for admin review via GET /admin/security/flags:
//
// - NEW_IP_FOR_WALLET    — wallet has prior activity but never from this IP
// - HIGH_REQUEST_RATE    — wallet exceeded the request threshold inside the
//                          configured sliding window
// - UNUSUAL_HOUR_ACCESS  — request landed inside the configured quiet hours
//                          (UTC)

import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';
import { logger } from '../../utils/logger.utils';

export const NEW_IP_FOR_WALLET = 'NEW_IP_FOR_WALLET';
export const HIGH_REQUEST_RATE = 'HIGH_REQUEST_RATE';
export const UNUSUAL_HOUR_ACCESS = 'UNUSUAL_HOUR_ACCESS';

/** One UNUSUAL_HOUR_ACCESS flag per wallet per this window (dedup). */
const UNUSUAL_HOUR_DEDUP_MS = 24 * 60 * 60 * 1000;

export interface SessionActivityInput {
   wallet: string;
   ip: string;
   userAgent: string | null;
   method: string;
   endpoint: string;
   statusCode: number;
}

interface AnomalyRuleDeps {
   findFirst: typeof prisma.sessionActivity.findFirst;
   count: typeof prisma.sessionActivity.count;
   securityFlagCreate: typeof prisma.securityFlag.create;
   securityFlagFindFirst: typeof prisma.securityFlag.findFirst;
   now: () => Date;
}

const defaultDeps: AnomalyRuleDeps = {
   findFirst: args => prisma.sessionActivity.findFirst(args),
   count: args => prisma.sessionActivity.count(args),
   securityFlagCreate: args => prisma.securityFlag.create(args),
   securityFlagFindFirst: args => prisma.securityFlag.findFirst(args),
   now: () => new Date(),
};

/**
 * Persists one activity row per authenticated request. Never throws —
 * activity logging must not take down the request path.
 */
export async function recordSessionActivity(
   input: SessionActivityInput
): Promise<void> {
   if (!envConfig.SESSION_ACTIVITY_LOGGING_ENABLED) {
      return;
   }

   try {
      const activity = await prisma.sessionActivity.create({
         data: {
            wallet: input.wallet,
            ip: input.ip,
            userAgent: input.userAgent,
            method: input.method,
            endpoint: input.endpoint,
            statusCode: input.statusCode,
         },
      });

      await detectAnomalies(activity.id, input, {
         now: () => activity.timestamp,
      });
   } catch (error) {
      logger.error(
         { type: 'session_activity_log_error', error, wallet: input.wallet },
         'Failed to record session activity'
      );
   }
}

/**
 * Runs the three anomaly rules for a freshly written activity row and
 * creates a SecurityFlag for each rule that trips. Rules are independent;
 * one request can raise multiple flags.
 */
export async function detectAnomalies(
   activityId: string,
   input: SessionActivityInput,
   deps?: Partial<AnomalyRuleDeps>
): Promise<string[]> {
   const d = { ...defaultDeps, ...deps };
   const now = d.now();
   const flaggedReasons: string[] = [];

   const [isNewIp, rateExceeded] = await Promise.all([
      checkNewIpForWallet(activityId, input, d),
      checkHighRequestRate(input, now, d),
   ]);

   const unusualHour = checkUnusualHourAccess(now);

   // NEW_IP is self-limiting (once the IP is on record it never re-fires),
   // but rate and quiet-hours rules stay true for every request inside the
   // window — without dedup a single burst would flood the flag table.
   const [recentRateFlag, recentUnusualHourFlag] = await Promise.all([
      rateExceeded !== null
         ? d.securityFlagFindFirst({
              where: {
                 wallet: input.wallet,
                 reason: HIGH_REQUEST_RATE,
                 createdAt: {
                    gte: new Date(
                       now.getTime() -
                          envConfig.SESSION_ANOMALY_RATE_WINDOW_MINUTES *
                             60 *
                             1000
                    ),
                 },
              },
              select: { id: true },
           })
         : Promise.resolve(null),
      unusualHour
         ? d.securityFlagFindFirst({
              where: {
                 wallet: input.wallet,
                 reason: UNUSUAL_HOUR_ACCESS,
                 createdAt: {
                    gte: new Date(now.getTime() - UNUSUAL_HOUR_DEDUP_MS),
                 },
              },
              select: { id: true },
           })
         : Promise.resolve(null),
   ]);

   if (isNewIp) {
      flaggedReasons.push(NEW_IP_FOR_WALLET);
      await createFlag(d, {
         wallet: input.wallet,
         ip: input.ip,
         userAgent: input.userAgent,
         endpoint: input.endpoint,
         reason: NEW_IP_FOR_WALLET,
         details: { activityId },
      });
   }

   if (rateExceeded !== null && recentRateFlag === null) {
      flaggedReasons.push(HIGH_REQUEST_RATE);
      await createFlag(d, {
         wallet: input.wallet,
         ip: input.ip,
         userAgent: input.userAgent,
         endpoint: input.endpoint,
         reason: HIGH_REQUEST_RATE,
         details: {
            activityId,
            requestCount: rateExceeded.requestCount,
            windowMinutes: rateExceeded.windowMinutes,
         },
      });
   }

   if (unusualHour && recentUnusualHourFlag === null) {
      flaggedReasons.push(UNUSUAL_HOUR_ACCESS);
      await createFlag(d, {
         wallet: input.wallet,
         ip: input.ip,
         userAgent: input.userAgent,
         endpoint: input.endpoint,
         reason: UNUSUAL_HOUR_ACCESS,
         details: { activityId, hourUtc: now.getUTCHours() },
      });
   }

   return flaggedReasons;
}

/**
 * NEW_IP_FOR_WALLET: the wallet has prior activity from a different IP, but
 * has never been seen from this one. The current activity row is excluded
 * from both probes (it would otherwise match itself). First-seen wallets
 * are not flagged — their initial IP is necessarily new.
 */
async function checkNewIpForWallet(
   activityId: string,
   input: SessionActivityInput,
   d: AnomalyRuleDeps
): Promise<boolean> {
   const [priorOtherIp, priorSameIp] = await Promise.all([
      d.findFirst({
         where: {
            id: { not: activityId },
            wallet: input.wallet,
            ip: { not: input.ip },
         },
         select: { id: true },
      }),
      d.findFirst({
         where: {
            id: { not: activityId },
            wallet: input.wallet,
            ip: input.ip,
         },
         select: { id: true },
      }),
   ]);

   return priorOtherIp !== null && priorSameIp === null;
}

/**
 * HIGH_REQUEST_RATE: sliding-window count of the wallet's requests. Returns
 * the breach details when the threshold is exceeded, else null.
 */
async function checkHighRequestRate(
   input: SessionActivityInput,
   now: Date,
   d: AnomalyRuleDeps
): Promise<{ requestCount: number; windowMinutes: number } | null> {
   const windowMinutes = envConfig.SESSION_ANOMALY_RATE_WINDOW_MINUTES;
   const threshold = envConfig.SESSION_ANOMALY_RATE_THRESHOLD;
   const windowStart = new Date(now.getTime() - windowMinutes * 60 * 1000);

   const requestCount = await d.count({
      where: {
         wallet: input.wallet,
         timestamp: { gte: windowStart },
      },
   });

   if (requestCount < threshold) {
      return null;
   }

   return { requestCount, windowMinutes };
}

/**
 * UNUSUAL_HOUR_ACCESS: request timestamp falls inside the configured quiet
 * hours (UTC). Supports windows that wrap midnight, e.g. 23–5.
 */
function checkUnusualHourAccess(now: Date): boolean {
   const start = envConfig.SESSION_ANOMALY_UNUSUAL_HOUR_START;
   const end = envConfig.SESSION_ANOMALY_UNUSUAL_HOUR_END;
   const hour = now.getUTCHours();

   if (start === end) {
      return false;
   }

   return start < end
      ? hour >= start && hour < end
      : hour >= start || hour < end;
}

async function createFlag(
   d: AnomalyRuleDeps,
   flag: {
      wallet: string;
      ip: string;
      userAgent: string | null;
      endpoint: string;
      reason: string;
      details: Record<string, unknown>;
   }
): Promise<void> {
   try {
      await d.securityFlagCreate({
         data: {
            wallet: flag.wallet,
            ip: flag.ip,
            userAgent: flag.userAgent,
            endpoint: flag.endpoint,
            reason: flag.reason,
            details: flag.details as Prisma.InputJsonValue,
         },
      });
   } catch (error) {
      logger.error(
         { type: 'security_flag_create_error', error, reason: flag.reason },
         'Failed to create security flag'
      );
   }
}

export interface FlaggedSessionQuery {
   limit: number;
   offset: number;
   wallet?: string;
   reason?: string;
}

export interface FlaggedSession {
   id: string;
   wallet: string;
   ip: string | null;
   userAgent: string | null;
   endpoint: string | null;
   reason: string;
   details: Record<string, unknown> | null;
   createdAt: string;
}

export interface FlaggedSessionsPage {
   flags: FlaggedSession[];
   total: number;
   limit: number;
   offset: number;
}

/**
 * Paginated flagged sessions for the admin security dashboard, newest
 * first, with optional wallet/reason filters.
 */
export async function getFlaggedSessions(
   query: FlaggedSessionQuery
): Promise<FlaggedSessionsPage> {
   const where: Prisma.SecurityFlagWhereInput = {};
   if (query.wallet) {
      where.wallet = query.wallet;
   }
   if (query.reason) {
      where.reason = query.reason;
   }

   const [rows, total] = await Promise.all([
      prisma.securityFlag.findMany({
         where,
         orderBy: { createdAt: 'desc' },
         skip: query.offset,
         take: query.limit,
      }),
      prisma.securityFlag.count({ where }),
   ]);

   return {
      flags: rows.map(row => ({
         id: row.id,
         wallet: row.wallet,
         ip: row.ip,
         userAgent: row.userAgent,
         endpoint: row.endpoint,
         reason: row.reason,
         details:
            (row.details as Record<string, unknown> | null) ?? null,
         createdAt: row.createdAt.toISOString(),
      })),
      total,
      limit: query.limit,
      offset: query.offset,
   };
}
