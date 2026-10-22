// src/jobs/session-activity-cleanup.job.ts
// Prunes session_activity and security_flags rows older than the retention
// window (default 30 days) so the security monitoring tables stay bounded
// (#1035). Follows the price-history-cleanup batching pattern.

import { envConfig } from '../config';
import { logger } from '../utils/logger.utils';
import { prisma } from '../utils/prisma.utils';

export type SessionActivityCleanupResult = {
   cutoffTimestamp: Date;
   deletedActivities: number;
   deletedFlags: number;
   retentionDays: number;
};

type SessionActivityCleanupDeps = {
   activityDeleteMany: typeof prisma.sessionActivity.deleteMany;
   flagDeleteMany: typeof prisma.securityFlag.deleteMany;
   activityFindMany: typeof prisma.sessionActivity.findMany;
   flagFindMany: typeof prisma.securityFlag.findMany;
   now: () => Date;
   batchSize: number;
};

function getCutoffTimestamp(now: Date, retentionDays: number): Date {
   const cutoffMs = retentionDays * 24 * 60 * 60 * 1000;
   return new Date(now.getTime() - cutoffMs);
}

/**
 * Deletes every session_activity and security_flags row recorded before
 * the retention cutoff (default: 30 days ago), in bounded batches so a
 * large backlog doesn't hold a long-running lock.
 */
export async function cleanupExpiredSessionActivity(
   deps?: Partial<SessionActivityCleanupDeps>
): Promise<SessionActivityCleanupResult> {
   const d: SessionActivityCleanupDeps = {
      activityDeleteMany:
         deps?.activityDeleteMany ??
         prisma.sessionActivity.deleteMany.bind(prisma.sessionActivity),
      flagDeleteMany:
         deps?.flagDeleteMany ??
         prisma.securityFlag.deleteMany.bind(prisma.securityFlag),
      activityFindMany:
         deps?.activityFindMany ??
         prisma.sessionActivity.findMany.bind(prisma.sessionActivity),
      flagFindMany:
         deps?.flagFindMany ??
         prisma.securityFlag.findMany.bind(prisma.securityFlag),
      now: deps?.now ?? (() => new Date()),
      batchSize: deps?.batchSize ?? 5000,
   };

   const retentionDays = envConfig.SESSION_ACTIVITY_RETENTION_DAYS;
   const cutoffTimestamp = getCutoffTimestamp(d.now(), retentionDays);

   let deletedActivities = 0;
   for (;;) {
      const rows = await d.activityFindMany({
         where: { timestamp: { lt: cutoffTimestamp } },
         select: { id: true },
         take: d.batchSize,
      });
      if (rows.length === 0) break;
      const { count } = await d.activityDeleteMany({
         where: { id: { in: rows.map(row => row.id) } },
      });
      deletedActivities += count;
      if (rows.length < d.batchSize) break;
   }

   let deletedFlags = 0;
   for (;;) {
      const rows = await d.flagFindMany({
         where: { createdAt: { lt: cutoffTimestamp } },
         select: { id: true },
         take: d.batchSize,
      });
      if (rows.length === 0) break;
      const { count } = await d.flagDeleteMany({
         where: { id: { in: rows.map(row => row.id) } },
      });
      deletedFlags += count;
      if (rows.length < d.batchSize) break;
   }

   logger.info(
      {
         cutoffTimestamp: cutoffTimestamp.toISOString(),
         retentionDays,
         deletedActivities,
         deletedFlags,
      },
      'Session activity cleanup completed'
   );

   return { cutoffTimestamp, deletedActivities, deletedFlags, retentionDays };
}

let cleanupTimer: NodeJS.Timeout | null = null;

export function startSessionActivityCleanupJob() {
   if (!envConfig.SESSION_ACTIVITY_CLEANUP_ENABLED) {
      logger.info('Session activity cleanup job is disabled');
      return;
   }

   const intervalMs =
      envConfig.SESSION_ACTIVITY_CLEANUP_INTERVAL_MINUTES * 60 * 1000;

   const run = async () => {
      try {
         await cleanupExpiredSessionActivity();
      } catch (error) {
         logger.error(
            { err: error },
            'Session activity cleanup failed with an unexpected error'
         );
      }
   };

   void run();
   cleanupTimer = setInterval(() => {
      void run();
   }, intervalMs);

   if (typeof cleanupTimer.unref === 'function') {
      cleanupTimer.unref();
   }

   logger.info(
      {
         intervalMinutes: envConfig.SESSION_ACTIVITY_CLEANUP_INTERVAL_MINUTES,
         retentionDays: envConfig.SESSION_ACTIVITY_RETENTION_DAYS,
      },
      'Session activity cleanup job started'
   );
}

export function stopSessionActivityCleanupJob() {
   if (!cleanupTimer) {
      return;
   }

   clearInterval(cleanupTimer);
   cleanupTimer = null;
   logger.info('Session activity cleanup job stopped');
}
