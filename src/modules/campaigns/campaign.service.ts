// src/modules/campaigns/campaign.service.ts
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';

export class CampaignNotFoundError extends Error {
   constructor(campaignId: string) {
      super(`Campaign not found: ${campaignId}`);
      this.name = 'CampaignNotFoundError';
   }
}

export interface CampaignItem {
   campaign_id: string;
   title: string;
   description: string | null;
   status: string;
   criteria: any;
   reward_pool: string;
   starts_at: string;
   ends_at: string | null;
}

export interface CampaignEligibilityResponse {
   campaign_id: string;
   wallet: string;
   is_eligible: boolean;
   criteria_progress: string;
   criteria_score: string;
   claimable_amount: string;
   claimed_amount: string;
}

export interface CampaignLeaderboardEntry {
   rank: number;
   wallet: string;
   criteria_score: string;
   is_eligible: boolean;
}

export interface CampaignLeaderboardResponse {
   campaign_id: string;
   leaderboard: CampaignLeaderboardEntry[];
   total: number;
}

export const CAMPAIGN_CACHE_TTL_SECONDS = 60;

export function getCampaignListCacheKey(): string {
   return 'campaigns:list';
}

export function getCampaignEligibilityCacheKey(campaignId: string, wallet: string): string {
   return `campaigns:${campaignId}:eligibility:${wallet}`;
}

export function getCampaignLeaderboardCacheKey(campaignId: string): string {
   return `campaigns:${campaignId}:leaderboard`;
}

export async function invalidateCampaignCache(campaignId?: string, wallet?: string): Promise<void> {
   try {
      await cacheInvalidate(getCampaignListCacheKey());
      if (campaignId) {
         await cacheInvalidate(getCampaignLeaderboardCacheKey(campaignId));
         if (wallet) {
            await cacheInvalidate(getCampaignEligibilityCacheKey(campaignId, wallet));
         }
      }
   } catch (error) {
      logger.warn({ error, campaignId, wallet }, 'Failed to invalidate campaign cache');
   }
}

export async function getCampaigns(): Promise<CampaignItem[]> {
   const cacheKey = getCampaignListCacheKey();
   const cached = await cacheGetJson<CampaignItem[]>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   const campaigns = await prisma.campaign.findMany({
      orderBy: { startsAt: 'desc' },
   });

   const result: CampaignItem[] = campaigns.map(c => {
      let parsedCriteria: any = {};
      try {
         parsedCriteria = JSON.parse(c.criteria);
      } catch {
         parsedCriteria = c.criteria;
      }

      return {
         campaign_id: c.campaignId,
         title: c.title,
         description: c.description,
         status: c.status,
         criteria: parsedCriteria,
         reward_pool: c.rewardPool.toString(),
         starts_at: c.startsAt.toISOString(),
         ends_at: c.endsAt ? c.endsAt.toISOString() : null,
      };
   });

   try {
      await cacheSetJson(cacheKey, result, CAMPAIGN_CACHE_TTL_SECONDS);
   } catch (error) {
      logger.warn({ error }, 'Failed to cache campaign list');
   }

   return result;
}

export async function getCampaignEligibility(
   campaignId: string,
   wallet: string
): Promise<CampaignEligibilityResponse> {
   const cacheKey = getCampaignEligibilityCacheKey(campaignId, wallet);
   const cached = await cacheGetJson<CampaignEligibilityResponse>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   const campaign = await prisma.campaign.findUnique({
      where: { campaignId },
      select: { campaignId: true },
   });

   if (!campaign) {
      throw new CampaignNotFoundError(campaignId);
   }

   const eligibility = await prisma.campaignEligibility.findUnique({
      where: {
         campaignId_wallet: {
            campaignId,
            wallet,
         },
      },
   });

   const result: CampaignEligibilityResponse = {
      campaign_id: campaignId,
      wallet,
      is_eligible: eligibility ? eligibility.isEligible : false,
      criteria_progress: eligibility ? eligibility.criteriaProgress.toString() : '0',
      criteria_score: eligibility ? eligibility.criteriaScore.toString() : '0',
      claimable_amount: eligibility ? eligibility.claimableAmount.toString() : '0',
      claimed_amount: eligibility ? eligibility.claimedAmount.toString() : '0',
   };

   try {
      await cacheSetJson(cacheKey, result, CAMPAIGN_CACHE_TTL_SECONDS);
   } catch (error) {
      logger.warn({ error, campaignId, wallet }, 'Failed to cache campaign eligibility');
   }

   return result;
}

export async function getCampaignLeaderboard(
   campaignId: string,
   limit = 50
): Promise<CampaignLeaderboardResponse> {
   const cacheKey = getCampaignLeaderboardCacheKey(campaignId);
   const cached = await cacheGetJson<CampaignLeaderboardResponse>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   const campaign = await prisma.campaign.findUnique({
      where: { campaignId },
      select: { campaignId: true },
   });

   if (!campaign) {
      throw new CampaignNotFoundError(campaignId);
   }

   const entries = await prisma.campaignEligibility.findMany({
      where: { campaignId, isEligible: true },
      orderBy: { criteriaScore: 'desc' },
      take: Math.min(Math.max(1, limit), 100),
      select: {
         wallet: true,
         criteriaScore: true,
         isEligible: true,
      },
   });

   const leaderboard: CampaignLeaderboardEntry[] = entries.map((entry, idx) => ({
      rank: idx + 1,
      wallet: entry.wallet,
      criteria_score: entry.criteriaScore.toString(),
      is_eligible: entry.isEligible,
   }));

   const result: CampaignLeaderboardResponse = {
      campaign_id: campaignId,
      leaderboard,
      total: leaderboard.length,
   };

   try {
      await cacheSetJson(cacheKey, result, CAMPAIGN_CACHE_TTL_SECONDS);
   } catch (error) {
      logger.warn({ error, campaignId }, 'Failed to cache campaign leaderboard');
   }

   return result;
}
