// src/jobs/campaign-cron.job.ts
// Background cron services for campaigns:
// 1. Daily cron evaluating active campaign criteria against wallet activity
//    and calling qualify_wallet on-chain for newly eligible wallets.
// 2. Campaign end cron transitioning ended campaigns to claimable state.

import { envConfig } from '../config';
import { logger } from '../utils/logger.utils';
import {
   evaluateActiveCampaigns,
   transitionEndedCampaigns,
   type CampaignServiceDeps,
} from '../modules/campaigns';

let evaluationTimer: NodeJS.Timeout | null = null;
let endCheckTimer: NodeJS.Timeout | null = null;

/**
 * Runs the daily campaign evaluation cycle.
 * Also transitions expired campaigns so active evaluations only run for current campaigns.
 */
export async function runDailyCampaignEvaluation(
   deps?: Partial<CampaignServiceDeps>
) {
   // Ensure expired campaigns are moved to claimable before evaluation
   const transitionResult = await transitionEndedCampaigns(deps);
   const evaluationResult = await evaluateActiveCampaigns(deps);

   logger.info(
      {
         transitionedCampaigns: transitionResult.transitionedCount,
         scannedCampaigns: evaluationResult.scannedCampaigns,
         qualifiedCount: evaluationResult.qualifiedCount,
         failedCount: evaluationResult.failedCount,
         alreadyQualifiedSkipped: evaluationResult.alreadyQualifiedSkipped,
      },
      'Daily campaign evaluation job cycle completed'
   );

   return {
      transitionResult,
      evaluationResult,
   };
}

/**
 * Runs the campaign expiry transition check.
 */
export async function runCampaignEndCheck(
   deps?: Partial<CampaignServiceDeps>
) {
   const transitionResult = await transitionEndedCampaigns(deps);
   logger.info(
      {
         transitionedCampaigns: transitionResult.transitionedCount,
         campaignIds: transitionResult.campaignIds,
      },
      'Campaign end check cycle completed'
   );
   return transitionResult;
}

export function startCampaignDailyEvaluationJob(): void {
   if (!envConfig.CAMPAIGN_CRON_ENABLED) {
      logger.info('Campaign daily evaluation job is disabled');
      return;
   }

   const intervalMs =
      envConfig.CAMPAIGN_EVALUATION_INTERVAL_HOURS * 60 * 60 * 1000;

   const run = async () => {
      try {
         await runDailyCampaignEvaluation();
      } catch (error) {
         logger.error(
            { err: error },
            'Campaign daily evaluation job failed with an unexpected error'
         );
      }
   };

   void run();
   evaluationTimer = setInterval(() => {
      void run();
   }, intervalMs);

   if (typeof evaluationTimer.unref === 'function') {
      evaluationTimer.unref();
   }

   logger.info(
      { intervalHours: envConfig.CAMPAIGN_EVALUATION_INTERVAL_HOURS },
      'Campaign daily evaluation job started'
   );
}

export function stopCampaignDailyEvaluationJob(): void {
   if (!evaluationTimer) {
      return;
   }

   clearInterval(evaluationTimer);
   evaluationTimer = null;
   logger.info('Campaign daily evaluation job stopped');
}

export function startCampaignEndJob(): void {
   if (!envConfig.CAMPAIGN_CRON_ENABLED) {
      logger.info('Campaign end check job is disabled');
      return;
   }

   const intervalMs =
      envConfig.CAMPAIGN_END_CHECK_INTERVAL_MINUTES * 60 * 1000;

   const run = async () => {
      try {
         await runCampaignEndCheck();
      } catch (error) {
         logger.error(
            { err: error },
            'Campaign end check job failed with an unexpected error'
         );
      }
   };

   void run();
   endCheckTimer = setInterval(() => {
      void run();
   }, intervalMs);

   if (typeof endCheckTimer.unref === 'function') {
      endCheckTimer.unref();
   }

   logger.info(
      { intervalMinutes: envConfig.CAMPAIGN_END_CHECK_INTERVAL_MINUTES },
      'Campaign end check job started'
   );
}

export function stopCampaignEndJob(): void {
   if (!endCheckTimer) {
      return;
   }

   clearInterval(endCheckTimer);
   endCheckTimer = null;
   logger.info('Campaign end check job stopped');
}

export function startCampaignCronJobs(): void {
   startCampaignDailyEvaluationJob();
   startCampaignEndJob();
}

export function stopCampaignCronJobs(): void {
   stopCampaignDailyEvaluationJob();
   stopCampaignEndJob();
}
