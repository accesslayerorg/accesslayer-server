// src/jobs/health-monitor.worker.ts
// Scans every open lending-vault position on a fixed interval, recomputes its
// health from the collateral key's TWAP, and stores the result in vault_health.
// A borrower is flagged (warningAt) the first pass their health drops below the
// warning threshold; the flag is cleared on recovery so each drop warns once.

import { envConfig } from '../config';
import { logger } from '../utils/logger.utils';
import { prisma } from '../utils/prisma.utils';
import {
   computeVaultHealth,
   HEALTH_WARNING_THRESHOLD,
   loadCollateralPriceXlm,
} from '../modules/vault/vault-health.service';

/** The monitor sweeps all open positions every 30 seconds. */
export const HEALTH_MONITOR_INTERVAL_MS = 30_000;

export interface HealthMonitorResult {
   scanned: number;
   warned: number;
   skipped: number;
}

type CollateralPriceLoader = (
   keyId: string,
   now: Date
) => Promise<number | null>;

/**
 * One monitor sweep. Positions whose collateral price cannot be read keep
 * their previous health row and are reported as skipped.
 */
export async function runHealthMonitorPass(
   now: Date = new Date(),
   loadPrice: CollateralPriceLoader = loadCollateralPriceXlm
): Promise<HealthMonitorResult> {
   const positions = await prisma.lendingPosition.findMany({
      where: { liquidatedAt: null },
      include: { health: { select: { warningAt: true } } },
   });

   let warned = 0;
   let skipped = 0;

   for (const position of positions) {
      const price = await loadPrice(position.collateralKeyId, now);
      if (price === null) {
         skipped += 1;
         continue;
      }

      const health = computeVaultHealth(
         {
            collateralQuantity: Number(position.collateralQuantity),
            principalXlm: Number(position.principalXlm),
            interestRateBps: position.interestRateBps,
            openedAt: position.openedAt,
         },
         price,
         now
      );

      const previousWarningAt = position.health?.warningAt ?? null;
      const isWarning = health.healthFactor < HEALTH_WARNING_THRESHOLD;
      if (isWarning && previousWarningAt === null) warned += 1;

      const data = {
         wallet: position.wallet,
         healthFactor: health.healthFactor,
         collateralValueXlm: health.collateralValueXlm,
         debtXlm: health.debtXlm,
         liquidationPriceXlm: health.liquidationPriceXlm,
         warningAt: isWarning ? previousWarningAt ?? now : null,
         computedAt: now,
      };

      await prisma.vaultHealth.upsert({
         where: { positionId: position.id },
         create: { positionId: position.id, ...data },
         update: data,
      });
   }

   logger.debug(
      { scanned: positions.length, warned, skipped },
      'health-monitor: sweep completed'
   );

   return { scanned: positions.length, warned, skipped };
}

let monitorTimer: ReturnType<typeof setInterval> | null = null;

export function startHealthMonitorWorker(): void {
   if (!envConfig.VAULT_HEALTH_MONITOR_ENABLED) {
      logger.info('health-monitor worker is disabled');
      return;
   }

   const run = async () => {
      try {
         await runHealthMonitorPass();
      } catch (error) {
         logger.error(
            { err: error },
            'health-monitor failed with an unexpected error'
         );
      }
   };

   void run();
   monitorTimer = setInterval(() => {
      void run();
   }, HEALTH_MONITOR_INTERVAL_MS);

   if (typeof monitorTimer.unref === 'function') {
      monitorTimer.unref();
   }

   logger.info(
      { intervalMs: HEALTH_MONITOR_INTERVAL_MS },
      'health-monitor worker started'
   );
}

export function stopHealthMonitorWorker(): void {
   if (monitorTimer) {
      clearInterval(monitorTimer);
      monitorTimer = null;
   }
   logger.info('health-monitor worker stopped');
}
