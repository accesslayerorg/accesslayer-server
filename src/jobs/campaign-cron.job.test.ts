// src/jobs/campaign-cron.job.test.ts

jest.mock('../config', () => ({
   envConfig: {
      CAMPAIGN_CRON_ENABLED: true,
      CAMPAIGN_EVALUATION_INTERVAL_HOURS: 24,
      CAMPAIGN_END_CHECK_INTERVAL_MINUTES: 60,
      CAMPAIGN_QUALIFICATION_BATCH_SIZE: 100,
      CAMPAIGN_QUALIFICATION_CONCURRENCY: 5,
   },
}));

jest.mock('../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
   },
}));

jest.mock('../modules/campaigns', () => ({
   evaluateActiveCampaigns: jest.fn(),
   transitionEndedCampaigns: jest.fn(),
}));

import { envConfig } from '../config';
import {
   evaluateActiveCampaigns,
   transitionEndedCampaigns,
} from '../modules/campaigns';
import {
   runDailyCampaignEvaluation,
   runCampaignEndCheck,
   startCampaignDailyEvaluationJob,
   stopCampaignDailyEvaluationJob,
   startCampaignEndJob,
   stopCampaignEndJob,
   startCampaignCronJobs,
   stopCampaignCronJobs,
} from './campaign-cron.job';

describe('Campaign Cron Job', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      stopCampaignCronJobs();
      envConfig.CAMPAIGN_CRON_ENABLED = true;
      (transitionEndedCampaigns as jest.Mock).mockResolvedValue({
         transitionedCount: 1,
         campaignIds: ['c1'],
      });
      (evaluateActiveCampaigns as jest.Mock).mockResolvedValue({
         scannedCampaigns: 2,
         evaluatedWallets: 10,
         qualifiedCount: 5,
         failedCount: 0,
         alreadyQualifiedSkipped: 3,
      });
   });

   afterEach(() => {
      stopCampaignCronJobs();
   });

   it('runDailyCampaignEvaluation calls transitionEndedCampaigns then evaluateActiveCampaigns', async () => {
      const result = await runDailyCampaignEvaluation();

      expect(transitionEndedCampaigns).toHaveBeenCalledTimes(1);
      expect(evaluateActiveCampaigns).toHaveBeenCalledTimes(1);
      expect(result.transitionResult.transitionedCount).toBe(1);
      expect(result.evaluationResult.qualifiedCount).toBe(5);
   });

   it('runCampaignEndCheck calls transitionEndedCampaigns', async () => {
      const result = await runCampaignEndCheck();

      expect(transitionEndedCampaigns).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
         transitionedCount: 1,
         campaignIds: ['c1'],
      });
   });

   it('does not start timers if CAMPAIGN_CRON_ENABLED is false', () => {
      envConfig.CAMPAIGN_CRON_ENABLED = false;

      startCampaignDailyEvaluationJob();
      startCampaignEndJob();

      expect(transitionEndedCampaigns).not.toHaveBeenCalled();
   });

   it('starts and stops timers cleanly', () => {
      startCampaignDailyEvaluationJob();
      expect(transitionEndedCampaigns).toHaveBeenCalled();
      stopCampaignDailyEvaluationJob();

      startCampaignEndJob();
      stopCampaignEndJob();

      startCampaignCronJobs();
      stopCampaignCronJobs();
   });
});
