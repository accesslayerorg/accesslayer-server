import { Campaign, CampaignEligibility } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';

export const CAMPAIGN_CACHE_TTL_SECONDS = 60;
type CampaignDates = { startDate: Date; endDate: Date };
type CachedCampaign = {
   campaign_id: string; name: string; description: string | null;
   criteria: { type: string; threshold: string; filters: unknown };
   reward_pool: string; start_date: string; end_date: string;
};
type CampaignPage = {
   items: CachedCampaign[]; total: number; limit: number; offset: number;
};

export function campaignReadStatus(campaign: CampaignDates, now: Date) {
   if (now < campaign.startDate) return 'upcoming';
   return now >= campaign.endDate ? 'ended' : 'active';
}

export async function invalidateCampaignCache(campaignId: string): Promise<void> {
   await cacheInvalidate('campaigns:list:*', 'campaigns:' + campaignId + ':*');
}

export async function listCampaigns(limit = 25, offset = 0, now = new Date()) {
   const key = 'campaigns:list:' + limit + ':' + offset;
   const cached = await cacheGetJson<CampaignPage>(key);
   const page = cached ?? await loadCampaignPage(limit, offset);
   if (!cached) await cacheSetJson(key, page, CAMPAIGN_CACHE_TTL_SECONDS);
   return {
      ...page,
      items: page.items.map(row => ({
         ...row,
         status: campaignReadStatus({
            startDate: new Date(row.start_date), endDate: new Date(row.end_date),
         }, now),
      })),
   };
}

async function loadCampaignPage(limit: number, offset: number): Promise<CampaignPage> {
   const [rows, total] = await Promise.all([
      prisma.campaign.findMany({
         orderBy: [{ startDate: 'desc' }, { id: 'asc' }], take: limit, skip: offset,
      }),
      prisma.campaign.count(),
   ]);
   return {
      items: rows.map((row: Campaign) => ({
         campaign_id: row.id, name: row.name, description: row.description,
         criteria: { type: row.criteriaType, threshold: row.threshold.toString(), filters: row.criteria },
         reward_pool: row.rewardPool.toString(),
         start_date: row.startDate.toISOString(), end_date: row.endDate.toISOString(),
      })),
      total, limit, offset,
   };
}

/** Contract total_score only increases as previously unqualified wallets join. */
async function campaignTotalScore(campaignId: string): Promise<string> {
   const result = await prisma.campaignEvent.aggregate({
      where: { campaignId, type: 'qualified' }, _max: { totalScore: true },
   });
   return result._max.totalScore?.toString() ?? '0';
}

/** Same integer floor as seasonal-rewards: reward_pool * score / total_score. */
export function campaignReward(pool: string, score: string, totalScore: string, claimed: string): string {
   const total = BigInt(totalScore);
   const numerator = BigInt(pool) * BigInt(score);
   if (numerator > (1n << 127n) - 1n) return '0';
   const payout = total > 0n ? numerator / total : 0n;
   const remaining = payout - BigInt(claimed);
   return (remaining > 0n ? remaining : 0n).toString();
}

export async function getCampaignEligibility(campaignId: string, wallet: string, now = new Date()) {
   const key = 'campaigns:' + campaignId + ':eligibility:' + wallet;
   const cached = await cacheGetJson<ReturnType<typeof eligibilityResponse>>(key);
   if (cached) return withClaimability(cached, now);
   const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
   if (!campaign) return null;
   const [row, totalScore] = await Promise.all([
      prisma.campaignEligibility.findUnique({ where: { campaignId_wallet: { campaignId, wallet } } }),
      campaignTotalScore(campaignId),
   ]);
   const result = eligibilityResponse(campaign, wallet, row, totalScore);
   await cacheSetJson(key, result, CAMPAIGN_CACHE_TTL_SECONDS);
   return withClaimability(result, now);
}

function eligibilityResponse(campaign: Campaign, wallet: string, row: CampaignEligibility | null, totalScore: string) {
   const score = row?.score.toString() ?? '0';
   const claimed = row?.claimedAmount.toString() ?? '0';
   return {
      campaign_id: campaign.id, wallet, eligible: row?.eligible ?? false,
      claimed: row?.claimed ?? false, available_at: campaign.endDate.toISOString(),
      criteria_progress: {
         score, threshold: campaign.threshold.toString(), total_score: totalScore,
         details: row?.criteriaProgress ?? null,
      },
      reward_amount: row?.eligible ? campaignReward(campaign.rewardPool.toString(), score, totalScore, '0') : '0',
      claimable_amount: '0',
      claimed_amount: claimed,
   };
}

function withClaimability(result: ReturnType<typeof eligibilityResponse>, now: Date) {
   return {
      ...result,
      claimable_amount: result.eligible && !result.claimed && now >= new Date(result.available_at)
         ? result.reward_amount : '0',
   };
}

export async function getCampaignLeaderboard(campaignId: string, limit = 25) {
   const key = 'campaigns:' + campaignId + ':leaderboard:' + limit;
   const cached = await cacheGetJson<{ campaign_id: string; items: unknown[] }>(key);
   if (cached) return cached;
   const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
   if (!campaign) return null;
   const [rows, totalScore] = await Promise.all([
      prisma.campaignEligibility.findMany({
         where: { campaignId, eligible: true },
         orderBy: [{ score: 'desc' }, { wallet: 'asc' }], take: limit,
      }),
      campaignTotalScore(campaignId),
   ]);
   const result = {
      campaign_id: campaignId,
      items: rows.map((row: CampaignEligibility, index: number) => ({
         rank: index + 1, wallet: row.wallet, score: row.score.toString(),
         claimed: row.claimed, reward_amount: campaignReward(campaign.rewardPool.toString(), row.score.toString(), totalScore, '0'),
      })),
   };
   await cacheSetJson(key, result, CAMPAIGN_CACHE_TTL_SECONDS);
   return result;
}
