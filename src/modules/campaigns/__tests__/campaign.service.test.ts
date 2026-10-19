// src/modules/campaigns/__tests__/campaign.service.test.ts
import { Decimal } from '@prisma/client/runtime/library';

let cacheStore = new Map<string, any>();

jest.mock('../../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) => cacheStore.get(key) ?? null),
   cacheSetJson: jest.fn(async (key: string, val: any) => {
      cacheStore.set(key, val);
   }),
   cacheInvalidate: jest.fn(async (key: string) => {
      cacheStore.delete(key);
   }),
}));

const prismaMock = {
   campaign: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
   },
   campaignEligibility: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
   },
};

jest.mock('../../../utils/prisma.utils', () => ({
   prisma: prismaMock,
}));

import {
   getCampaigns,
   getCampaignEligibility,
   getCampaignLeaderboard,
   invalidateCampaignCache,
   CampaignNotFoundError,
} from '../campaign.service';

describe('campaign.service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      cacheStore.clear();
   });

   describe('getCampaigns', () => {
      it('returns parsed campaigns list accurately', async () => {
         const startsAt = new Date('2026-04-01T00:00:00Z');
         prismaMock.campaign.findMany.mockResolvedValueOnce([
            {
               campaignId: 'camp-1',
               title: 'Spring Trading Festival',
               description: 'Trade keys to earn XLM',
               status: 'active',
               criteria: JSON.stringify({ minVolume: 100 }),
               rewardPool: new Decimal('10000'),
               startsAt,
               endsAt: null,
            },
         ]);

         const list = await getCampaigns();

         expect(list).toHaveLength(1);
         expect(list[0].campaign_id).toBe('camp-1');
         expect(list[0].title).toBe('Spring Trading Festival');
         expect(list[0].criteria).toEqual({ minVolume: 100 });
         expect(list[0].reward_pool).toBe('10000');
         expect(list[0].starts_at).toBe(startsAt.toISOString());
      });

      it('returns cached list if present', async () => {
         const cached = [
            {
               campaign_id: 'camp-cached',
               title: 'Cached Camp',
               description: null,
               status: 'active',
               criteria: {},
               reward_pool: '500',
               starts_at: '2026-04-01T00:00:00.000Z',
               ends_at: null,
            },
         ];
         cacheStore.set('campaigns:list', cached);

         const list = await getCampaigns();

         expect(list).toEqual(cached);
         expect(prismaMock.campaign.findMany).not.toHaveBeenCalled();
      });
   });

   describe('getCampaignEligibility', () => {
      it('throws CampaignNotFoundError if campaign missing', async () => {
         prismaMock.campaign.findUnique.mockResolvedValueOnce(null);

         await expect(getCampaignEligibility('not-found', 'GWALLET')).rejects.toThrow(CampaignNotFoundError);
      });

      it('returns default zero eligibility when wallet not yet qualified', async () => {
         prismaMock.campaign.findUnique.mockResolvedValueOnce({ campaignId: 'camp-2' });
         prismaMock.campaignEligibility.findUnique.mockResolvedValueOnce(null);

         const res = await getCampaignEligibility('camp-2', 'GNEW');

         expect(res.campaign_id).toBe('camp-2');
         expect(res.wallet).toBe('GNEW');
         expect(res.is_eligible).toBe(false);
         expect(res.claimable_amount).toBe('0');
      });

      it('returns qualified status and claimable amount accurately', async () => {
         prismaMock.campaign.findUnique.mockResolvedValueOnce({ campaignId: 'camp-2' });
         prismaMock.campaignEligibility.findUnique.mockResolvedValueOnce({
            campaignId: 'camp-2',
            wallet: 'GQUALIFIED',
            isEligible: true,
            criteriaProgress: new Decimal('100'),
            criteriaScore: new Decimal('85.5'),
            claimableAmount: new Decimal('250'),
            claimedAmount: new Decimal('50'),
         });

         const res = await getCampaignEligibility('camp-2', 'GQUALIFIED');

         expect(res.is_eligible).toBe(true);
         expect(res.criteria_progress).toBe('100');
         expect(res.criteria_score).toBe('85.5');
         expect(res.claimable_amount).toBe('250');
         expect(res.claimed_amount).toBe('50');
      });
   });

   describe('getCampaignLeaderboard', () => {
      it('throws CampaignNotFoundError if campaign missing', async () => {
         prismaMock.campaign.findUnique.mockResolvedValueOnce(null);

         await expect(getCampaignLeaderboard('missing-camp')).rejects.toThrow(CampaignNotFoundError);
      });

      it('returns sorted and ranked qualifying wallets', async () => {
         prismaMock.campaign.findUnique.mockResolvedValueOnce({ campaignId: 'camp-3' });
         prismaMock.campaignEligibility.findMany.mockResolvedValueOnce([
            { wallet: 'GW1', criteriaScore: new Decimal('100'), isEligible: true },
            { wallet: 'GW2', criteriaScore: new Decimal('80'), isEligible: true },
         ]);

         const res = await getCampaignLeaderboard('camp-3');

         expect(res.campaign_id).toBe('camp-3');
         expect(res.total).toBe(2);
         expect(res.leaderboard[0]).toEqual({
            rank: 1,
            wallet: 'GW1',
            criteria_score: '100',
            is_eligible: true,
         });
         expect(res.leaderboard[1]).toEqual({
            rank: 2,
            wallet: 'GW2',
            criteria_score: '80',
            is_eligible: true,
         });
      });
   });

   describe('invalidateCampaignCache', () => {
      it('invalidates list, leaderboard, and eligibility caches', async () => {
         cacheStore.set('campaigns:list', true);
         cacheStore.set('campaigns:c1:leaderboard', true);
         cacheStore.set('campaigns:c1:eligibility:w1', true);

         await invalidateCampaignCache('c1', 'w1');

         expect(cacheStore.has('campaigns:list')).toBe(false);
         expect(cacheStore.has('campaigns:c1:leaderboard')).toBe(false);
         expect(cacheStore.has('campaigns:c1:eligibility:w1')).toBe(false);
      });
   });
});
