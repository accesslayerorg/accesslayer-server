// src/modules/campaigns/campaign-qualification.service.test.ts

jest.mock('../../config', () => ({
   envConfig: {
      CAMPAIGN_CRON_ENABLED: true,
      CAMPAIGN_EVALUATION_INTERVAL_HOURS: 24,
      CAMPAIGN_END_CHECK_INTERVAL_MINUTES: 60,
      CAMPAIGN_QUALIFICATION_BATCH_SIZE: 100,
      CAMPAIGN_QUALIFICATION_CONCURRENCY: 5,
   },
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
   },
}));

import {
   evaluateActiveCampaigns,
   transitionEndedCampaigns,
} from './campaign-qualification.service';
import type { CampaignContractClient } from './campaign.types';

describe('Campaign Qualification Service', () => {
   const now = new Date('2026-10-20T12:00:00.000Z');

   const mockPrisma = {
      campaign: {
         findMany: jest.fn(),
         update: jest.fn(),
         updateMany: jest.fn(),
      },
      campaignQualificationLog: {
         findMany: jest.fn(),
         upsert: jest.fn(),
      },
      trade: {
         findMany: jest.fn(),
      },
      activity: {
         findMany: jest.fn(),
         groupBy: jest.fn(),
      },
   };

   const mockContractClient: CampaignContractClient = {
      qualifyWallet: jest.fn(),
      qualify_wallet: jest.fn(),
   };

   beforeEach(() => {
      jest.clearAllMocks();
      mockContractClient.qualifyWallet = jest
         .fn()
         .mockResolvedValue({ txHash: 'mock-tx-hash-123' });
      mockContractClient.qualify_wallet = mockContractClient.qualifyWallet;
   });

   describe('transitionEndedCampaigns', () => {
      it('transitions ended campaigns from ACTIVE to CLAIMABLE', async () => {
         mockPrisma.campaign.findMany.mockResolvedValueOnce([
            { id: 'camp-1' },
            { id: 'camp-2' },
         ]);
         mockPrisma.campaign.updateMany.mockResolvedValueOnce({ count: 2 });

         const result = await transitionEndedCampaigns({
            prisma: mockPrisma as any,
            now: () => now,
         });

         expect(result).toEqual({
            transitionedCount: 2,
            campaignIds: ['camp-1', 'camp-2'],
         });

         expect(mockPrisma.campaign.findMany).toHaveBeenCalledWith({
            where: {
               status: 'ACTIVE',
               endDate: { lte: now },
            },
            select: { id: true },
         });

         expect(mockPrisma.campaign.updateMany).toHaveBeenCalledWith({
            where: {
               id: { in: ['camp-1', 'camp-2'] },
               status: 'ACTIVE',
            },
            data: {
               status: 'CLAIMABLE',
            },
         });
      });

      it('returns 0 when no campaigns have ended', async () => {
         mockPrisma.campaign.findMany.mockResolvedValueOnce([]);

         const result = await transitionEndedCampaigns({
            prisma: mockPrisma as any,
            now: () => now,
         });

         expect(result).toEqual({
            transitionedCount: 0,
            campaignIds: [],
         });
         expect(mockPrisma.campaign.updateMany).not.toHaveBeenCalled();
      });
   });

   describe('evaluateActiveCampaigns', () => {
      it('identifies and qualifies eligible candidate wallets meeting the threshold', async () => {
         const mockCampaign = {
            id: 'camp-active-1',
            name: 'October Trading Contest',
            status: 'ACTIVE',
            criteriaType: 'TRADE_VOLUME',
            threshold: 50,
            startDate: new Date('2026-10-01T00:00:00.000Z'),
            endDate: new Date('2026-10-31T00:00:00.000Z'),
            criteria: null,
            lastCheckedAt: null,
         };

         mockPrisma.campaign.findMany.mockResolvedValueOnce([mockCampaign]);

         const queryCandidateWalletsBatch = jest.fn().mockResolvedValueOnce({
            candidates: [
               { wallet: 'GWALLET111', metricValue: 100 },
               { wallet: 'GWALLET222', metricValue: 80 },
            ],
            hasMore: false,
            totalProcessedInBatch: 2,
         });

         // None are qualified yet
         mockPrisma.campaignQualificationLog.findMany.mockResolvedValueOnce([]);
         mockPrisma.campaignQualificationLog.upsert.mockResolvedValue({});
         mockPrisma.campaign.update.mockResolvedValueOnce(mockCampaign);

         const result = await evaluateActiveCampaigns({
            prisma: mockPrisma as any,
            contractClient: mockContractClient,
            now: () => now,
            queryCandidateWalletsBatch,
            concurrency: 2,
         });

         expect(result).toEqual({
            scannedCampaigns: 1,
            evaluatedWallets: 2,
            qualifiedCount: 2,
            failedCount: 0,
            alreadyQualifiedSkipped: 0,
         });

         // qualify_wallet called for both wallets
         expect(mockContractClient.qualifyWallet).toHaveBeenCalledTimes(2);
         expect(mockContractClient.qualifyWallet).toHaveBeenCalledWith(
            'camp-active-1',
            'GWALLET111'
         );
         expect(mockContractClient.qualifyWallet).toHaveBeenCalledWith(
            'camp-active-1',
            'GWALLET222'
         );

         // Qualifications logged in campaign_qualification_log
         expect(mockPrisma.campaignQualificationLog.upsert).toHaveBeenCalledWith({
            where: {
               campaignId_wallet: {
                  campaignId: 'camp-active-1',
                  wallet: 'GWALLET111',
               },
            },
            create: {
               campaignId: 'camp-active-1',
               wallet: 'GWALLET111',
               status: 'QUALIFIED',
               metricValue: 100,
               txHash: 'mock-tx-hash-123',
               error: null,
               qualifiedAt: now,
            },
            update: {
               status: 'QUALIFIED',
               metricValue: 100,
               txHash: 'mock-tx-hash-123',
               error: null,
               qualifiedAt: now,
            },
         });

         // Campaign lastCheckedAt updated
         expect(mockPrisma.campaign.update).toHaveBeenCalledWith({
            where: { id: 'camp-active-1' },
            data: { lastCheckedAt: now },
         });
      });

      it('only calls qualify_wallet for wallets not yet qualified (skips already-qualified wallets)', async () => {
         const mockCampaign = {
            id: 'camp-active-2',
            name: 'Volume Sprint',
            status: 'ACTIVE',
            criteriaType: 'TRADE_VOLUME',
            threshold: 100,
            startDate: new Date('2026-10-01T00:00:00.000Z'),
            endDate: new Date('2026-10-31T00:00:00.000Z'),
            criteria: null,
            lastCheckedAt: null,
         };

         mockPrisma.campaign.findMany.mockResolvedValueOnce([mockCampaign]);

         const queryCandidateWalletsBatch = jest.fn().mockResolvedValueOnce({
            candidates: [
               { wallet: 'G_ALREADY_QUALIFIED', metricValue: 250 },
               { wallet: 'G_NEW_CANDIDATE', metricValue: 150 },
            ],
            hasMore: false,
            totalProcessedInBatch: 2,
         });

         // G_ALREADY_QUALIFIED was previously qualified
         mockPrisma.campaignQualificationLog.findMany.mockResolvedValueOnce([
            { wallet: 'G_ALREADY_QUALIFIED' },
         ]);
         mockPrisma.campaignQualificationLog.upsert.mockResolvedValue({});
         mockPrisma.campaign.update.mockResolvedValueOnce(mockCampaign);

         const result = await evaluateActiveCampaigns({
            prisma: mockPrisma as any,
            contractClient: mockContractClient,
            now: () => now,
            queryCandidateWalletsBatch,
         });

         expect(result).toEqual({
            scannedCampaigns: 1,
            evaluatedWallets: 2,
            qualifiedCount: 1,
            failedCount: 0,
            alreadyQualifiedSkipped: 1,
         });

         // qualify_wallet should ONLY be called for G_NEW_CANDIDATE
         expect(mockContractClient.qualifyWallet).toHaveBeenCalledTimes(1);
         expect(mockContractClient.qualifyWallet).toHaveBeenCalledWith(
            'camp-active-2',
            'G_NEW_CANDIDATE'
         );
      });

      it('logs FAILED in campaign_qualification_log when qualify_wallet contract call throws', async () => {
         const mockCampaign = {
            id: 'camp-err-1',
            name: 'Error Campaign',
            status: 'ACTIVE',
            criteriaType: 'TRADE_VOLUME',
            threshold: 10,
            startDate: new Date('2026-10-01T00:00:00.000Z'),
            endDate: new Date('2026-10-31T00:00:00.000Z'),
            criteria: null,
            lastCheckedAt: null,
         };

         mockPrisma.campaign.findMany.mockResolvedValueOnce([mockCampaign]);

         const queryCandidateWalletsBatch = jest.fn().mockResolvedValueOnce({
            candidates: [{ wallet: 'G_FAIL_WALLET', metricValue: 20 }],
            hasMore: false,
            totalProcessedInBatch: 1,
         });

         mockPrisma.campaignQualificationLog.findMany.mockResolvedValueOnce([]);
         mockContractClient.qualifyWallet = jest
            .fn()
            .mockRejectedValueOnce(new Error('RPC_NODE_TIMEOUT'));
         mockContractClient.qualify_wallet = mockContractClient.qualifyWallet;

         mockPrisma.campaignQualificationLog.upsert.mockResolvedValue({});
         mockPrisma.campaign.update.mockResolvedValueOnce(mockCampaign);

         const result = await evaluateActiveCampaigns({
            prisma: mockPrisma as any,
            contractClient: mockContractClient,
            now: () => now,
            queryCandidateWalletsBatch,
         });

         expect(result.failedCount).toBe(1);
         expect(result.qualifiedCount).toBe(0);

         expect(mockPrisma.campaignQualificationLog.upsert).toHaveBeenCalledWith({
            where: {
               campaignId_wallet: {
                  campaignId: 'camp-err-1',
                  wallet: 'G_FAIL_WALLET',
               },
            },
            create: {
               campaignId: 'camp-err-1',
               wallet: 'G_FAIL_WALLET',
               status: 'FAILED',
               metricValue: 20,
               error: 'RPC_NODE_TIMEOUT',
               qualifiedAt: now,
            },
            update: {
               status: 'FAILED',
               metricValue: 20,
               error: 'RPC_NODE_TIMEOUT',
            },
         });
      });

      it('handles large wallet sets through batching without timeout', async () => {
         const mockCampaign = {
            id: 'camp-large',
            name: 'Large Campaign',
            status: 'ACTIVE',
            criteriaType: 'TRADE_VOLUME',
            threshold: 10,
            startDate: new Date('2026-10-01T00:00:00.000Z'),
            endDate: new Date('2026-10-31T00:00:00.000Z'),
            criteria: null,
            lastCheckedAt: null,
         };

         mockPrisma.campaign.findMany.mockResolvedValueOnce([mockCampaign]);

         // Batch 1 returns hasMore: true
         // Batch 2 returns hasMore: false
         const queryCandidateWalletsBatch = jest
            .fn()
            .mockResolvedValueOnce({
               candidates: [
                  { wallet: 'GWALLET_BATCH1_A', metricValue: 50 },
                  { wallet: 'GWALLET_BATCH1_B', metricValue: 60 },
               ],
               hasMore: true,
               totalProcessedInBatch: 2,
            })
            .mockResolvedValueOnce({
               candidates: [{ wallet: 'GWALLET_BATCH2_C', metricValue: 70 }],
               hasMore: false,
               totalProcessedInBatch: 1,
            });

         mockPrisma.campaignQualificationLog.findMany
            .mockResolvedValueOnce([]) // batch 1
            .mockResolvedValueOnce([]); // batch 2
         mockPrisma.campaignQualificationLog.upsert.mockResolvedValue({});
         mockPrisma.campaign.update.mockResolvedValueOnce(mockCampaign);

         const result = await evaluateActiveCampaigns({
            prisma: mockPrisma as any,
            contractClient: mockContractClient,
            now: () => now,
            batchSize: 2,
            queryCandidateWalletsBatch,
         });

         expect(queryCandidateWalletsBatch).toHaveBeenCalledTimes(2);
         expect(queryCandidateWalletsBatch).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ offset: 0, batchSize: 2 })
         );
         expect(queryCandidateWalletsBatch).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ offset: 2, batchSize: 2 })
         );

         expect(result.qualifiedCount).toBe(3);
         expect(result.evaluatedWallets).toBe(3);
      });
   });
});
