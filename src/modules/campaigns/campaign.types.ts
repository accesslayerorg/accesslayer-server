// src/modules/campaigns/campaign.types.ts

export type CampaignStatus = 'ACTIVE' | 'CLAIMABLE' | 'ENDED';

export const CAMPAIGN_STATUS = {
   ACTIVE: 'ACTIVE',
   CLAIMABLE: 'CLAIMABLE',
   ENDED: 'ENDED',
} as const;

export type CampaignCriteriaType =
   | 'TRADE_VOLUME'
   | 'TRADE_COUNT'
   | 'ACTIVITY_COUNT'
   | (string & {});

export interface WalletActivityCandidate {
   wallet: string;
   metricValue: number;
}

export interface CampaignContractClient {
   qualifyWallet(
      campaignId: string,
      wallet: string
   ): Promise<{ txHash?: string }>;
   qualify_wallet?(
      campaign_id: string,
      wallet: string
   ): Promise<{ txHash?: string }>;
}

export interface CampaignEvaluationResult {
   scannedCampaigns: number;
   evaluatedWallets: number;
   qualifiedCount: number;
   failedCount: number;
   alreadyQualifiedSkipped: number;
}

export interface CampaignTransitionResult {
   transitionedCount: number;
   campaignIds: string[];
}

export interface CampaignEvaluationDeps {
   now: () => Date;
   contractClient: CampaignContractClient;
   batchSize: number;
   concurrency: number;
}
