// src/modules/campaigns/campaign.routes.ts
import { Router } from 'express';
import {
   sendSuccess,
   sendNotFound,
} from '../../utils/api-response.utils';
import { logger } from '../../utils/logger.utils';
import {
   getCampaigns,
   getCampaignEligibility,
   getCampaignLeaderboard,
   CampaignNotFoundError,
} from './campaign.service';

const router = Router();

/**
 * GET /api/v1/campaigns
 * List active, upcoming, and ended campaigns with criteria and reward pool.
 * Cached with 60s TTL.
 * No auth required.
 */
router.get('/', async (_req, res, next) => {
   try {
      const campaigns = await getCampaigns();
      sendSuccess(res, campaigns);
   } catch (error) {
      logger.error({ error }, 'Campaigns list fetch failed');
      next(error);
   }
});

/**
 * GET /api/v1/campaigns/:campaignId/eligibility/:wallet
 * Get eligibility flag, criteria progress, and claimable amount for a wallet.
 * Cached with 60s TTL.
 * No auth required.
 */
router.get('/:campaignId/eligibility/:wallet', async (req, res, next) => {
   try {
      const eligibility = await getCampaignEligibility(
         req.params.campaignId,
         req.params.wallet
      );
      sendSuccess(res, eligibility);
   } catch (error) {
      if (error instanceof CampaignNotFoundError) {
         sendNotFound(res, 'Campaign');
         return;
      }
      logger.error(
         { error, campaignId: req.params.campaignId, wallet: req.params.wallet },
         'Campaign eligibility fetch failed'
      );
      next(error);
   }
});

/**
 * GET /api/v1/campaigns/:campaignId/leaderboard
 * Get top qualifying wallets by criteria score.
 * Cached with 60s TTL.
 * No auth required.
 */
router.get('/:campaignId/leaderboard', async (req, res, next) => {
   try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
      const leaderboard = await getCampaignLeaderboard(
         req.params.campaignId,
         isNaN(limit) ? 50 : limit
      );
      sendSuccess(res, leaderboard);
   } catch (error) {
      if (error instanceof CampaignNotFoundError) {
         sendNotFound(res, 'Campaign');
         return;
      }
      logger.error(
         { error, campaignId: req.params.campaignId },
         'Campaign leaderboard fetch failed'
      );
      next(error);
   }
});

export default router;
