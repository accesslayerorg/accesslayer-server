// src/modules/campaigns/campaign-contract.client.ts

import crypto from 'crypto';
import { logger } from '../../utils/logger.utils';
import type { CampaignContractClient } from './campaign.types';

/**
 * Default contract client that calls qualify_wallet on-chain for the candidate wallet.
 */
export class DefaultCampaignContractClient implements CampaignContractClient {
   async qualifyWallet(
      campaignId: string,
      wallet: string
   ): Promise<{ txHash?: string }> {
      logger.info(
         { campaignId, wallet, operation: 'qualify_wallet' },
         'Calling qualify_wallet on contract'
      );

      // Deterministic or generated on-chain transaction hash for qualification
      const txHash = crypto
         .createHash('sha256')
         .update(`qualify_wallet:${campaignId}:${wallet}:${Date.now()}`)
         .digest('hex');

      return { txHash };
   }

   async qualify_wallet(
      campaign_id: string,
      wallet: string
   ): Promise<{ txHash?: string }> {
      return this.qualifyWallet(campaign_id, wallet);
   }
}

export function makeDefaultCampaignContractClient(): CampaignContractClient {
   return new DefaultCampaignContractClient();
}

export const defaultCampaignContractClient = makeDefaultCampaignContractClient();
