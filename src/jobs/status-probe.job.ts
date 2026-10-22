// src/jobs/status-probe.job.ts
// Background health probe job running every 60 seconds against all core dependencies (#1015).

import { envConfig } from '../config';
import { logger } from '../utils/logger.utils';
import { runAllProbes } from '../modules/status/status.service';

const DEFAULT_PROBE_INTERVAL_SECONDS = 60;

let probeTimer: ReturnType<typeof setInterval> | null = null;
let isProbeInFlight = false;

/**
 * Executes a single probe cycle across all core dependencies.
 * Prevents overlapping executions if a previous cycle is still in flight.
 */
export async function triggerStatusProbeNow(): Promise<void> {
   if (isProbeInFlight) {
      logger.warn(
         'Status probe cycle skipped: previous probe execution is still in flight'
      );
      return;
   }

   isProbeInFlight = true;
   try {
      logger.debug('Starting status probe cycle across all core dependencies');
      await runAllProbes();
      logger.debug('Status probe cycle completed');
   } catch (error) {
      logger.error(
         { error },
         'Status probe cycle encountered an unexpected error'
      );
   } finally {
      isProbeInFlight = false;
   }
}

/**
 * Starts the periodic background health probe job.
 * Runs probes immediately on start, then repeats every 60 seconds.
 */
export function startStatusProbeJob(): void {
   if (probeTimer) {
      logger.warn('Status probe job is already running');
      return;
   }

   const intervalSeconds =
      (envConfig as Record<string, unknown>).STATUS_PROBE_INTERVAL_SECONDS as
         | number
         | undefined ?? DEFAULT_PROBE_INTERVAL_SECONDS;
   const intervalMs = Math.max(1, intervalSeconds) * 1000;

   // Run immediately on boot
   void triggerStatusProbeNow();

   // Schedule repeated execution every 60s
   probeTimer = setInterval(() => {
      void triggerStatusProbeNow();
   }, intervalMs);

   if (
      typeof (probeTimer as unknown as { unref?: () => void }).unref ===
      'function'
   ) {
      (probeTimer as unknown as { unref: () => void }).unref();
   }

   logger.info(
      { intervalSeconds: intervalMs / 1000 },
      'Status health probe background job started'
   );
}

/**
 * Stops the periodic background health probe job.
 */
export function stopStatusProbeJob(): void {
   if (probeTimer) {
      clearInterval(probeTimer);
      probeTimer = null;
      logger.info('Status health probe background job stopped');
   }
}

/**
 * Checks whether the background probe job is currently scheduled.
 */
export function isStatusProbeJobRunning(): boolean {
   return probeTimer !== null;
}
