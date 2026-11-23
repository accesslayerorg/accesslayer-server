jest.unmock('@prisma/client');
jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      campaign: { findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
      campaignEligibility: { findUnique: jest.fn(), findMany: jest.fn() },
      campaignEvent: { aggregate: jest.fn() },
   },
}));
jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn().mockResolvedValue(null),
   cacheSetJson: jest.fn().mockResolvedValue(undefined),
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));
import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';
import {
   campaignReadStatus, campaignReward, getCampaignEligibility,
   getCampaignLeaderboard, listCampaigns, invalidateCampaignCache,
} from './campaign-read.service';

const campaign = {
   id: '1141', name: 'Volume sprint', description: null, status: 'ACTIVE',
   criteriaType: 'TRADE_VOLUME', criteria: null,
   threshold: new Prisma.Decimal(100), rewardPool: new Prisma.Decimal(500),
   startDate: new Date('2026-11-20T00:00:00Z'), endDate: new Date('2026-11-22T00:00:00Z'),
};
const wallet = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

describe('campaign read API', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      (cacheGetJson as jest.Mock).mockResolvedValue(null);
      (prisma.campaign.findUnique as jest.Mock).mockResolvedValue(campaign);
      (prisma.campaignEligibility.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.campaignEvent.aggregate as jest.Mock).mockResolvedValue({ _max: { totalScore: new Prisma.Decimal(200) } });
   });

   it('computes upcoming, active and ended status at exact boundaries', () => {
      expect(campaignReadStatus(campaign, campaign.startDate)).toBe('active');
      expect(campaignReadStatus(campaign, campaign.endDate)).toBe('ended');
      expect(campaignReadStatus(campaign, new Date('2026-11-19T00:00:00Z'))).toBe('upcoming');
   });

   it('recomputes status from cached campaign dates', async () => {
      (cacheGetJson as jest.Mock).mockResolvedValue({
         items: [{
            campaign_id: '1141', name: campaign.name, description: null,
            criteria: { type: 'TRADE_VOLUME', threshold: '100', filters: null },
            reward_pool: '500', start_date: campaign.startDate.toISOString(),
            end_date: campaign.endDate.toISOString(),
         }], total: 1, limit: 25, offset: 0,
      });
      expect((await listCampaigns(25, 0, campaign.endDate)).items[0].status).toBe('ended');
      expect(prisma.campaign.findMany).not.toHaveBeenCalled();
   });

   it('lists reward pools and caches pages for 60 seconds', async () => {
      (prisma.campaign.findMany as jest.Mock).mockResolvedValue([campaign]);
      (prisma.campaign.count as jest.Mock).mockResolvedValue(1);
      expect((await listCampaigns(25, 0, campaign.startDate)).items[0]).toMatchObject({ status: 'active', reward_pool: '500' });
      expect(cacheSetJson).toHaveBeenCalledWith('campaigns:list:25:0', expect.anything(), 60);
   });

   it('returns no eligibility or recorded progress before qualification', async () => {
      expect(await getCampaignEligibility('1141', wallet, campaign.endDate)).toMatchObject({
         eligible: false, claimed: false, claimable_amount: '0',
         criteria_progress: { score: '0', threshold: '100', total_score: '200' },
      });
   });

   it('uses contract integer-floor payout without precision loss', () => {
      expect(campaignReward('500', '123', '200', '0')).toBe('307');
      expect(campaignReward('100000000000000000003', '3', '4', '75000000000000000000')).toBe('2');
      expect(campaignReward('1', '1', '0', '0')).toBe('0');
      expect(campaignReward('1', '1', '1', '2')).toBe('0');
      expect(campaignReward(((1n << 127n) - 1n).toString(), '2', '2', '0')).toBe('0');
   });

   it('only exposes claimable amount after end and keeps zero claims final', async () => {
      const row = {
         eligible: true, score: new Prisma.Decimal(123), criteriaProgress: { volume: '123' },
         claimedAmount: new Prisma.Decimal(0), claimed: false,
      };
      (prisma.campaignEligibility.findUnique as jest.Mock).mockResolvedValue(row);
      expect(await getCampaignEligibility('1141', wallet, campaign.startDate)).toMatchObject({
         reward_amount: '307', claimable_amount: '0',
      });
      expect(await getCampaignEligibility('1141', wallet, campaign.endDate)).toMatchObject({
         claimable_amount: '307', criteria_progress: { score: '123', details: { volume: '123' } },
      });
      (prisma.campaignEligibility.findUnique as jest.Mock).mockResolvedValue({ ...row, claimed: true });
      expect(await getCampaignEligibility('1141', wallet, campaign.endDate)).toMatchObject({ claimed: true, claimable_amount: '0' });
   });

   it('re-evaluates a cached eligibility response across the end boundary', async () => {
      (cacheGetJson as jest.Mock).mockResolvedValue({
         campaign_id: '1141', wallet, eligible: true, claimed: false,
         available_at: campaign.endDate.toISOString(), reward_amount: '307',
         claimable_amount: '0', claimed_amount: '0',
         criteria_progress: { score: '123', threshold: '100', total_score: '200', details: null },
      });
      expect(await getCampaignEligibility('1141', wallet, campaign.endDate)).toMatchObject({ claimable_amount: '307' });
      expect(prisma.campaign.findUnique).not.toHaveBeenCalled();
   });

   it('returns null for unknown campaigns', async () => {
      (prisma.campaign.findUnique as jest.Mock).mockResolvedValue(null);
      expect(await getCampaignEligibility('missing', wallet)).toBeNull();
      expect(await getCampaignLeaderboard('missing', 25)).toBeNull();
   });

   it('ranks qualified wallets in score order with stable tie breaking', async () => {
      (prisma.campaignEligibility.findMany as jest.Mock).mockResolvedValue([
         { wallet: 'A', score: new Prisma.Decimal(123), claimed: false },
         { wallet: 'B', score: new Prisma.Decimal(77), claimed: true },
      ]);
      expect((await getCampaignLeaderboard('1141', 25))?.items).toMatchObject([
         { rank: 1, wallet: 'A', score: '123', reward_amount: '307' },
         { rank: 2, wallet: 'B', score: '77', claimed: true },
      ]);
      expect(prisma.campaignEligibility.findMany).toHaveBeenCalledWith(expect.objectContaining({
         where: { campaignId: '1141', eligible: true }, orderBy: [{ score: 'desc' }, { wallet: 'asc' }],
      }));
   });

   it('invalidates every page and wallet when cumulative scores change', async () => {
      await invalidateCampaignCache('1141');
      expect(cacheInvalidate).toHaveBeenCalledWith('campaigns:list:*', 'campaigns:1141:*');
   });
});
