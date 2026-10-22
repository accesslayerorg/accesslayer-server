// src/modules/campaigns/campaign-qualification.service.ts

import type { Campaign } from '@prisma/client';
import { prisma as defaultPrisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { envConfig } from '../../config';
import { defaultCampaignContractClient } from './campaign-contract.client';
import {
   fetchCandidateWalletsBatch,
   type FetchCandidatesInput,
   type FetchCandidatesResult,
} from './campaign-activity.utils';
import type {
   CampaignContractClient,
   CampaignEvaluationResult,
   CampaignTransitionResult,
   WalletActivityCandidate,
} from './campaign.types';

export interface CampaignServiceDeps {
   prisma?: typeof defaultPrisma;
   contractClient?: CampaignContractClient;
   now?: () => Date;
   batchSize?: number;
   concurrency?: number;
   queryCandidateWalletsBatch?: (
      input: FetchCandidatesInput
   ) => Promise<FetchCandidatesResult>;
}

/**
 * Executes a list of tasks in chunks to limit concurrency.
 */
async function runWithConcurrency<T, R>(
   items: T[],
   limit: number,
   fn: (item: T) => Promise<R>
): Promise<R[]> {
   const results: R[] = [];
   const effectiveLimit = Math.max(1, limit);

   for (let i = 0; i < items.length; i += effectiveLimit) {
      const chunk = items.slice(i, i + effectiveLimit);
      const chunkResults = await Promise.all(chunk.map(item => fn(item)));
      results.push(...chunkResults);
   }

   return results;
}

/**
 * Transitions campaigns whose end dates have passed to 'CLAIMABLE'.
 */
export async function transitionEndedCampaigns(
   deps?: Partial<CampaignServiceDeps>
): Promise<CampaignTransitionResult> {
   const prisma = deps?.prisma ?? defaultPrisma;
   const getNow = deps?.now ?? (() => new Date());
   const now = getNow();

   const endedCampaigns = await prisma.campaign.findMany({
      where: {
         status: 'ACTIVE',
         endDate: { lte: now },
      },
      select: { id: true },
   });

   if (endedCampaigns.length === 0) {
      return { transitionedCount: 0, campaignIds: [] };
   }

   const campaignIds = endedCampaigns.map(c => c.id);

   const updateResult = await prisma.campaign.updateMany({
      where: {
         id: { in: campaignIds },
         status: 'ACTIVE',
      },
      data: {
         status: 'CLAIMABLE',
      },
   });

   logger.info(
      { transitionedCount: updateResult.count, campaignIds },
      'Campaign end cron: transitioned ended campaigns to claimable state'
   );

   return {
      transitionedCount: updateResult.count,
      campaignIds,
   };
}

/**
 * Evaluates a single candidate wallet against the contract:
 * Calls qualify_wallet and persists the result in campaign_qualification_log.
 */
async function qualifySingleWallet(
   campaign: Campaign,
   candidate: WalletActivityCandidate,
   contractClient: CampaignContractClient,
   prisma: typeof defaultPrisma,
   now: Date
): Promise<{ status: 'QUALIFIED' | 'FAILED'; error?: string; txHash?: string }> {
   const { wallet, metricValue } = candidate;

   try {
      // Call qualify_wallet (or qualifyWallet) on the contract
      const callContract =
         contractClient.qualify_wallet?.bind(contractClient) ||
         contractClient.qualifyWallet?.bind(contractClient);

      const result = await callContract(campaign.id, wallet);
      const txHash = result?.txHash ?? null;

      await prisma.campaignQualificationLog.upsert({
         where: {
            campaignId_wallet: {
               campaignId: campaign.id,
               wallet,
            },
         },
         create: {
            campaignId: campaign.id,
            wallet,
            status: 'QUALIFIED',
            metricValue,
            txHash,
            error: null,
            qualifiedAt: now,
         },
         update: {
            status: 'QUALIFIED',
            metricValue,
            txHash,
            error: null,
            qualifiedAt: now,
         },
      });

      logger.info(
         { campaignId: campaign.id, wallet, metricValue, txHash },
         'Campaign qualification: wallet successfully qualified'
      );

      return { status: 'QUALIFIED', txHash: txHash ?? undefined };
   } catch (error: any) {
      const errorMessage =
         error instanceof Error ? error.message : String(error);

      await prisma.campaignQualificationLog.upsert({
         where: {
            campaignId_wallet: {
               campaignId: campaign.id,
               wallet,
            },
         },
         create: {
            campaignId: campaign.id,
            wallet,
            status: 'FAILED',
            metricValue,
            error: errorMessage,
            qualifiedAt: now,
         },
         update: {
            status: 'FAILED',
            metricValue,
            error: errorMessage,
         },
      });

      logger.warn(
         { campaignId: campaign.id, wallet, metricValue, error: errorMessage },
         'Campaign qualification: qualify_wallet call failed for candidate wallet'
      );

      return { status: 'FAILED', error: errorMessage };
   }
}

/**
 * Daily cron evaluator that checks all active campaign criteria against wallet activity,
 * calling qualify_wallet on the contract for candidate wallets not yet qualified.
 */
export async function evaluateActiveCampaigns(
   deps?: Partial<CampaignServiceDeps>
): Promise<CampaignEvaluationResult> {
   const prisma = deps?.prisma ?? defaultPrisma;
   const contractClient =
      deps?.contractClient ?? defaultCampaignContractClient;
   const getNow = deps?.now ?? (() => new Date());
   const now = getNow();
   const batchSize =
      deps?.batchSize ?? envConfig.CAMPAIGN_QUALIFICATION_BATCH_SIZE;
   const concurrency =
      deps?.concurrency ?? envConfig.CAMPAIGN_QUALIFICATION_CONCURRENCY;
   const queryBatch =
      deps?.queryCandidateWalletsBatch ?? fetchCandidateWalletsBatch;

   // 1. Fetch active campaigns
   const activeCampaigns = await prisma.campaign.findMany({
      where: {
         status: 'ACTIVE',
         startDate: { lte: now },
         endDate: { gt: now },
      },
   });

   let evaluatedWallets = 0;
   let qualifiedCount = 0;
   let failedCount = 0;
   let alreadyQualifiedSkipped = 0;

   for (const campaign of activeCampaigns) {
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
         // Query wallets with relevant activity since campaign start in batches
         const batchResult = await queryBatch({
            campaign,
            offset,
            batchSize,
            now,
            prisma,
         });

         const candidates = batchResult.candidates;
         evaluatedWallets += batchResult.totalProcessedInBatch;
         hasMore = batchResult.hasMore;
         offset += batchSize;

         if (candidates.length === 0) {
            continue;
         }

         // Find wallets in this batch that are already qualified for this campaign
         const candidateWallets = candidates.map(c => c.wallet);
         const existingQualifications =
            await prisma.campaignQualificationLog.findMany({
               where: {
                  campaignId: campaign.id,
                  wallet: { in: candidateWallets },
                  status: 'QUALIFIED',
               },
               select: { wallet: true },
            });

         const qualifiedWalletSet = new Set(
            existingQualifications.map(q => q.wallet)
         );

         // qualify_wallet only called for wallets not yet qualified
         const eligibleToQualify: WalletActivityCandidate[] = [];

         for (const candidate of candidates) {
            if (qualifiedWalletSet.has(candidate.wallet)) {
               alreadyQualifiedSkipped += 1;
            } else {
               eligibleToQualify.push(candidate);
            }
         }

         if (eligibleToQualify.length > 0) {
            const results = await runWithConcurrency(
               eligibleToQualify,
               concurrency,
               candidate =>
                  qualifySingleWallet(
                     campaign,
                     candidate,
                     contractClient,
                     prisma,
                     now
                  )
            );

            for (const r of results) {
               if (r.status === 'QUALIFIED') {
                  qualifiedCount += 1;
               } else {
                  failedCount += 1;
               }
            }
         }
      }

      // Record when this campaign was last checked
      await prisma.campaign.update({
         where: { id: campaign.id },
         data: { lastCheckedAt: now },
      });
   }

   logger.info(
      {
         scannedCampaigns: activeCampaigns.length,
         evaluatedWallets,
         qualifiedCount,
         failedCount,
         alreadyQualifiedSkipped,
      },
      'Campaign daily evaluation cron completed'
   );

   return {
      scannedCampaigns: activeCampaigns.length,
      evaluatedWallets,
      qualifiedCount,
      failedCount,
      alreadyQualifiedSkipped,
   };
}
