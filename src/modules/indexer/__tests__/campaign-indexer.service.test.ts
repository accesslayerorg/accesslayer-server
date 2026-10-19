// src/modules/indexer/__tests__/campaign-indexer.service.test.ts
import { Decimal } from '@prisma/client/runtime/library';

const prismaMock = {
   campaign: {
      upsert: jest.fn(),
   },
   campaignEligibility: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
   },
};

jest.mock('../../../utils/prisma.utils', () => ({
   prisma: prismaMock,
}));

const mockInvalidateCache = jest.fn();
jest.mock('../../campaigns/campaign.service', () => ({
   invalidateCampaignCache: mockInvalidateCache,
}));

import {
   processCampaignEvents,
   CampaignCreatedChainEvent,
   WalletQualifiedChainEvent,
   RewardClaimedChainEvent,
} from '../campaign-indexer.service';

describe('campaign-indexer.service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('handles CampaignCreated event and creates campaign row', async () => {
      prismaMock.campaign.upsert.mockResolvedValueOnce({});

      const event: CampaignCreatedChainEvent = {
         eventType: 'CampaignCreated',
         campaignId: 'camp-10',
         title: 'Summer Airdrop',
         description: 'Trade to qualify',
         rewardPool: '50000',
         criteria: { volumeThreshold: 1000 },
         txHash: '0x111',
         ledger: 300,
         eventIndex: 0,
      };

      await processCampaignEvents([event]);

      expect(prismaMock.campaign.upsert).toHaveBeenCalledWith(
         expect.objectContaining({
            where: { campaignId: 'camp-10' },
            create: expect.objectContaining({
               campaignId: 'camp-10',
               title: 'Summer Airdrop',
               rewardPool: new Decimal('50000'),
               criteria: JSON.stringify({ volumeThreshold: 1000 }),
            }),
         })
      );
      expect(mockInvalidateCache).toHaveBeenCalledWith('camp-10');
   });

   it('handles WalletQualified event and upserts eligibility with score', async () => {
      prismaMock.campaignEligibility.upsert.mockResolvedValueOnce({});

      const event: WalletQualifiedChainEvent = {
         eventType: 'WalletQualified',
         campaignId: 'camp-10',
         wallet: 'GWALLET1',
         criteriaProgress: '100',
         criteriaScore: '92.5',
         claimableAmount: '500',
         txHash: '0x112',
         ledger: 301,
         eventIndex: 0,
      };

      await processCampaignEvents([event]);

      expect(prismaMock.campaignEligibility.upsert).toHaveBeenCalledWith(
         expect.objectContaining({
            where: {
               campaignId_wallet: {
                  campaignId: 'camp-10',
                  wallet: 'GWALLET1',
               },
            },
            create: expect.objectContaining({
               isEligible: true,
               criteriaProgress: new Decimal('100'),
               criteriaScore: new Decimal('92.5'),
               claimableAmount: new Decimal('500'),
            }),
         })
      );
      expect(mockInvalidateCache).toHaveBeenCalledWith('camp-10', 'GWALLET1');
   });

   it('handles RewardClaimed event and updates claimable/claimed amounts', async () => {
      prismaMock.campaignEligibility.findUnique.mockResolvedValueOnce({
         campaignId: 'camp-10',
         wallet: 'GWALLET1',
         claimableAmount: new Decimal('500'),
         claimedAmount: new Decimal('0'),
      });
      prismaMock.campaignEligibility.update.mockResolvedValueOnce({});

      const event: RewardClaimedChainEvent = {
         eventType: 'RewardClaimed',
         campaignId: 'camp-10',
         wallet: 'GWALLET1',
         amount: '200',
         txHash: '0x113',
         ledger: 302,
         eventIndex: 0,
      };

      await processCampaignEvents([event]);

      expect(prismaMock.campaignEligibility.update).toHaveBeenCalledWith({
         where: {
            campaignId_wallet: {
               campaignId: 'camp-10',
               wallet: 'GWALLET1',
            },
         },
         data: {
            claimableAmount: new Decimal('300'),
            claimedAmount: new Decimal('200'),
         },
      });
      expect(mockInvalidateCache).toHaveBeenCalledWith('camp-10', 'GWALLET1');
   });

   it('ignores unrelated events', async () => {
      const event: any = {
         eventType: 'NON_CAMPAIGN_EVENT',
         campaignId: 'c-x',
         txHash: '0x114',
      };

      await processCampaignEvents([event]);

      expect(prismaMock.campaign.upsert).not.toHaveBeenCalled();
      expect(prismaMock.campaignEligibility.upsert).not.toHaveBeenCalled();
      expect(mockInvalidateCache).not.toHaveBeenCalled();
   });
});
