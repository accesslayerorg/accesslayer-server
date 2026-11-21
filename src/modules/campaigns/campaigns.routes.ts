import { Router } from 'express';
import { StrKey } from '@stellar/stellar-base';
import { z } from 'zod';
import { AsyncController } from '../../types/auth.types';
import { sendSuccess, sendNotFound, sendValidationError, zodIssuesToDetails } from '../../utils/api-response.utils';
import { listCampaigns, getCampaignEligibility, getCampaignLeaderboard } from './campaign-read.service';

const campaignsRouter = Router();
const campaignIdSchema = z.string().trim().min(1).max(128);
const walletSchema = z.string().refine(StrKey.isValidEd25519PublicKey, 'Invalid Stellar wallet');
const integerQuery = (fallback: string, minimum: number, maximum: number) =>
   z.preprocess(value => value === undefined ? fallback : value,
      z.string().regex(/^[0-9]+$/).transform(Number).pipe(z.number().int().min(minimum).max(maximum)));
const listQuerySchema = z.object({
   limit: integerQuery('25', 1, 100), offset: integerQuery('0', 0, 1000000),
});
const leaderboardQuerySchema = z.object({ limit: integerQuery('25', 1, 100) });

const list: AsyncController = async (req, res, next) => {
   const query = listQuerySchema.safeParse(req.query);
   if (!query.success) return sendValidationError(res, 'Invalid pagination', zodIssuesToDetails(query.error.issues));
   try { sendSuccess(res, await listCampaigns(query.data.limit, query.data.offset)); }
   catch (error) { next(error); }
};

const eligibility: AsyncController = async (req, res, next) => {
   const params = z.object({ campaign_id: campaignIdSchema, wallet: walletSchema }).safeParse(req.params);
   if (!params.success) return sendValidationError(res, 'Invalid campaign or wallet', zodIssuesToDetails(params.error.issues));
   try {
      const result = await getCampaignEligibility(params.data.campaign_id, params.data.wallet);
      if (!result) return sendNotFound(res, 'Campaign');
      sendSuccess(res, result);
   } catch (error) { next(error); }
};

const leaderboard: AsyncController = async (req, res, next) => {
   const id = campaignIdSchema.safeParse(req.params.campaign_id);
   const query = leaderboardQuerySchema.safeParse(req.query);
   if (!id.success) return sendValidationError(res, 'Invalid campaign ID', zodIssuesToDetails(id.error.issues));
   if (!query.success) return sendValidationError(res, 'Invalid pagination', zodIssuesToDetails(query.error.issues));
   try {
      const result = await getCampaignLeaderboard(id.data, query.data.limit);
      if (!result) return sendNotFound(res, 'Campaign');
      sendSuccess(res, result);
   } catch (error) { next(error); }
};

campaignsRouter.get('/', list);
campaignsRouter.get('/:campaign_id/eligibility/:wallet', eligibility);
campaignsRouter.get('/:campaign_id/leaderboard', leaderboard);
campaignsRouter.all(['/', '/:campaign_id/eligibility/:wallet', '/:campaign_id/leaderboard'], (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

export default campaignsRouter;
