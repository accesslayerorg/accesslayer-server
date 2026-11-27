// src/jobs/key-analytics-leaderboard.job.ts
// Rebuilds the cached platform key leaderboards (volume, holders, reputation)
// every 5 minutes, matching KEY_ANALYTICS_LEADERBOARD_CACHE_SECONDS, so
// GET /analytics/keys/leaderboard serves cached rankings.

import { logger } from '../utils/logger.utils';
import { refreshAllKeyAnalyticsLeaderboards } from '../modules/analytics/key-leaderboard-analytics.service';

const KEY_ANALYTICS_LEADERBOARD_INTERVAL_MS = 5 * 60 * 1000;
let analyticsTimer: ReturnType<typeof setInterval> | null = null;

export async function refreshKeyAnalyticsLeaderboardsOnce(): Promise<void> {
   await refreshAllKeyAnalyticsLeaderboards();
}

export function startKeyAnalyticsLeaderboardJob(): void {
   if (analyticsTimer) {
      return;
   }

   const run = async () => {
      try {
         await refreshKeyAnalyticsLeaderboardsOnce();
      } catch (error) {
         logger.error(
            { err: error },
            'Key analytics leaderboard refresh job failed'
         );
      }
   };

   analyticsTimer = setInterval(() => {
      void run();
   }, KEY_ANALYTICS_LEADERBOARD_INTERVAL_MS);

   if (
      typeof (analyticsTimer as unknown as { unref?: () => void }).unref ===
      'function'
   ) {
      (analyticsTimer as unknown as { unref: () => void }).unref();
   }
}

export function stopKeyAnalyticsLeaderboardJob(): void {
   if (analyticsTimer) {
      clearInterval(analyticsTimer);
      analyticsTimer = null;
   }
}
