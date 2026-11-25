// src/jobs/lp-reward-accrual.job.ts
// Hourly key LP reward accrual (#1196). Runs once at startup (catching up
// missed epochs) and then just after every UTC hour boundary, once the
// epoch that ended has settled. See lp-reward-accrual.service.ts.

import { envConfig } from '../config';
import { logger } from '../utils/logger.utils';
import {
   LP_REWARD_EPOCH_MS,
   LP_REWARD_SETTLE_MS,
   runLpRewardAccrual,
} from '../modules/lp-rewards/lp-reward-accrual.service';

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let started = false;

/** Milliseconds from `now` until the next epoch boundary + settle delay. */
export function msUntilNextLpRewardRun(now: Date = new Date()): number {
   const t = now.getTime();
   const nextBoundary = Math.floor(t / LP_REWARD_EPOCH_MS) * LP_REWARD_EPOCH_MS + LP_REWARD_SETTLE_MS;
   return nextBoundary > t ? nextBoundary - t : nextBoundary + LP_REWARD_EPOCH_MS - t;
}

/** Runs the accrual once; overlapping invocations are skipped. */
export async function runLpRewardAccrualTick(now: Date = new Date()): Promise<boolean> {
   if (running) {
      logger.warn('lp-reward-accrual: previous run still in progress, skipping');
      return false;
   }
   running = true;
   try {
      await runLpRewardAccrual(now);
      return true;
   } catch (error) {
      logger.error({ err: error }, 'lp-reward-accrual failed with an unexpected error');
      return false;
   } finally {
      running = false;
   }
}

function scheduleNext(): void {
   if (!started) return;
   timer = setTimeout(() => {
      void runLpRewardAccrualTick().finally(scheduleNext);
   }, msUntilNextLpRewardRun());
   timer.unref?.();
}

export function startLpRewardAccrualJob(): void {
   if (!envConfig.LP_REWARD_ACCRUAL_ENABLED) {
      logger.info('lp-reward-accrual job is disabled');
      return;
   }
   if (started) return;
   started = true;

   void runLpRewardAccrualTick();
   scheduleNext();

   logger.info({ lpFeeBps: envConfig.LP_FEE_BPS }, 'lp-reward-accrual job started');
}

export function stopLpRewardAccrualJob(): void {
   started = false;
   if (timer) {
      clearTimeout(timer);
      timer = null;
   }
   logger.info('lp-reward-accrual job stopped');
}
