import { logger } from '../utils/logger.utils';
import { ScreenerService } from '../modules/screener/screener.service';

const REFRESH_INTERVAL_MS = 60_000;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

export async function refreshKeyMetricsOnce(): Promise<void> {
   await ScreenerService.refreshKeyMetrics();
}

export function startRefreshKeyMetricsJob(): void {
   if (refreshTimer) {
      return;
   }

   const run = async () => {
      try {
         await refreshKeyMetricsOnce();
      } catch (error) {
         logger.error({ err: error }, 'refreshKeyMetrics job failed');
      }
   };

   refreshTimer = setInterval(() => {
      void run();
   }, REFRESH_INTERVAL_MS);

   if (
      typeof (refreshTimer as unknown as { unref?: () => void }).unref ===
      'function'
   ) {
      (refreshTimer as unknown as { unref: () => void }).unref();
   }
}

export function stopRefreshKeyMetricsJob(): void {
   if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
   }
}
