import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../utils/prisma.utils';
import { sendError, sendSuccess, sendValidationError, zodIssuesToDetails } from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import { CAMPAIGN_LEADERBOARD_CACHE_TTL_SECONDS } from './campaign-leaderboard.cache';
import { cacheControl } from '../../middlewares/cache-control.middleware';

const router = Router();
const limitSchema = z.coerce.number().int().min(1).max(100).default(25);

router.get('/', cacheControl({ maxAge: 60, type: 'public' }), async (_req, res, next) => {
  try {
    const campaigns = await prisma.campaign.findMany({
      orderBy: { startDate: 'desc' },
      select: { id: true, name: true, description: true, status: true, criteriaType: true, threshold: true, criteria: true, startDate: true, endDate: true },
    });
    sendSuccess(res, { items: campaigns });
  } catch (error) { next(error); }
});

router.get('/:campaignId/eligibility/:wallet', cacheControl({ maxAge: 60, type: 'public' }), async (req, res, next) => {
  try {
    const campaign = await prisma.campaign.findUnique({ where: { id: req.params.campaignId }, select: { id: true, threshold: true, status: true } });
    if (!campaign) { sendError(res, 404, ErrorCode.NOT_FOUND, 'Campaign not found'); return; }
    const qualification = await prisma.campaignQualificationLog.findUnique({ where: { campaignId_wallet: { campaignId: campaign.id, wallet: req.params.wallet } } });
    sendSuccess(res, {
      campaignId: campaign.id,
      wallet: req.params.wallet,
      qualified: qualification?.status === 'QUALIFIED',
      criteriaProgress: qualification?.metricValue ?? 0,
      threshold: campaign.threshold,
      claimableAmount: qualification?.status === 'QUALIFIED' ? qualification.metricValue ?? 0 : 0,
      status: qualification?.status ?? 'PENDING',
    });
  } catch (error) { next(error); }
});

router.get('/:campaignId/leaderboard', cacheControl({ maxAge: CAMPAIGN_LEADERBOARD_CACHE_TTL_SECONDS, type: 'public' }), async (req, res, next) => {
  const parsed = z.object({ limit: limitSchema }).safeParse(req.query);
  if (!parsed.success) { sendValidationError(res, 'Invalid campaign leaderboard query', zodIssuesToDetails(parsed.error.issues)); return; }
  try {
    const campaign = await prisma.campaign.findUnique({ where: { id: req.params.campaignId }, select: { id: true } });
    if (!campaign) { sendError(res, 404, ErrorCode.NOT_FOUND, 'Campaign not found'); return; }
    const rows = await prisma.campaignQualificationLog.findMany({ where: { campaignId: campaign.id, status: 'QUALIFIED' }, orderBy: [{ metricValue: 'desc' }, { qualifiedAt: 'asc' }], take: parsed.data.limit, select: { wallet: true, metricValue: true, status: true } });
    sendSuccess(res, { items: rows.map((row, index) => ({ rank: index + 1, wallet: row.wallet, score: row.metricValue ?? 0, criteriaProgress: row.metricValue ?? 0, qualified: row.status === 'QUALIFIED' })) });
  } catch (error) { next(error); }
});

export default router;
