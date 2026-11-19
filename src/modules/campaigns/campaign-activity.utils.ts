// src/modules/campaigns/campaign-activity.utils.ts

import type { Campaign } from '@prisma/client';
import { prisma as defaultPrisma } from '../../utils/prisma.utils';
import type { WalletActivityCandidate } from './campaign.types';

export interface FetchCandidatesInput {
   campaign: Campaign;
   offset: number;
   batchSize: number;
   now?: Date;
   prisma?: typeof defaultPrisma;
}

export interface FetchCandidatesResult {
   candidates: WalletActivityCandidate[];
   hasMore: boolean;
   totalProcessedInBatch: number;
}

/**
 * Parses optional criteria filters from Campaign.criteria Json field.
 */
function parseCriteriaFilters(criteria: unknown): {
   creatorId?: string;
   keyId?: string;
   activityType?: any;
} {
   if (!criteria || typeof criteria !== 'object') {
      return {};
   }
   const obj = criteria as Record<string, any>;
   return {
      creatorId: obj.creatorId || obj.keyId,
      keyId: obj.keyId || obj.creatorId,
      activityType: obj.activityType,
   };
}

/**
 * Fetches a batch of candidate wallets with their computed activity metrics
 * since the campaign start date.
 */
export async function fetchCandidateWalletsBatch(
   input: FetchCandidatesInput
): Promise<FetchCandidatesResult> {
   const {
      campaign,
      offset,
      batchSize,
      now = new Date(),
      prisma = defaultPrisma,
   } = input;

   const maxDate = campaign.endDate < now ? campaign.endDate : now;
   const criteriaFilters = parseCriteriaFilters(campaign.criteria);
   const threshold = Number(campaign.threshold ?? 0);
   const criteriaType = (campaign.criteriaType || 'TRADE_VOLUME').toUpperCase();

   if (criteriaType === 'ACTIVITY_COUNT') {
      const distinctActors = await prisma.activity.findMany({
         where: {
            createdAt: { gte: campaign.startDate, lte: maxDate },
            ...(criteriaFilters.creatorId
               ? { creatorId: criteriaFilters.creatorId }
               : {}),
            ...(criteriaFilters.activityType
               ? { type: criteriaFilters.activityType }
               : {}),
         },
         distinct: ['actor'],
         select: { actor: true },
         skip: offset,
         take: batchSize,
         orderBy: { actor: 'asc' },
      });

      if (distinctActors.length === 0) {
         return { candidates: [], hasMore: false, totalProcessedInBatch: 0 };
      }

      const actors = distinctActors.map(a => a.actor);
      const activityCounts = await prisma.activity.groupBy({
         by: ['actor'],
         where: {
            actor: { in: actors },
            createdAt: { gte: campaign.startDate, lte: maxDate },
            ...(criteriaFilters.creatorId
               ? { creatorId: criteriaFilters.creatorId }
               : {}),
            ...(criteriaFilters.activityType
               ? { type: criteriaFilters.activityType }
               : {}),
         },
         _count: { _all: true },
      });

      const candidates: WalletActivityCandidate[] = [];
      for (const row of activityCounts) {
         const count = row._count._all;
         if (count >= threshold) {
            candidates.push({
               wallet: row.actor,
               metricValue: count,
            });
         }
      }

      return {
         candidates,
         hasMore: distinctActors.length === batchSize,
         totalProcessedInBatch: distinctActors.length,
      };
   }

   // Default: TRADE_VOLUME or TRADE_COUNT
   const distinctBuyers = await prisma.trade.findMany({
      where: {
         timestamp: { gte: campaign.startDate, lte: maxDate },
         ...(criteriaFilters.creatorId
            ? { creatorId: criteriaFilters.creatorId }
            : {}),
      },
      distinct: ['buyer'],
      select: { buyer: true },
      skip: offset,
      take: batchSize,
      orderBy: { buyer: 'asc' },
   });

   if (distinctBuyers.length === 0) {
      return { candidates: [], hasMore: false, totalProcessedInBatch: 0 };
   }

   const buyers = distinctBuyers.map(b => b.buyer);
   const trades = await prisma.trade.findMany({
      where: {
         buyer: { in: buyers },
         timestamp: { gte: campaign.startDate, lte: maxDate },
         ...(criteriaFilters.creatorId
            ? { creatorId: criteriaFilters.creatorId }
            : {}),
      },
      select: {
         buyer: true,
         price: true,
         quantity: true,
      },
   });

   const walletMetrics = new Map<string, number>();

   for (const trade of trades) {
      const current = walletMetrics.get(trade.buyer) ?? 0;
      if (criteriaType === 'TRADE_COUNT') {
         walletMetrics.set(trade.buyer, current + 1);
      } else {
         // TRADE_VOLUME: sum(price * quantity)
         const volume = Number(trade.price) * Number(trade.quantity);
         walletMetrics.set(
            trade.buyer,
            current + (isNaN(volume) ? 0 : volume)
         );
      }
   }

   const candidates: WalletActivityCandidate[] = [];
   for (const [wallet, metricValue] of walletMetrics.entries()) {
      if (metricValue >= threshold) {
         candidates.push({ wallet, metricValue });
      }
   }

   return {
      candidates,
      hasMore: distinctBuyers.length === batchSize,
      totalProcessedInBatch: distinctBuyers.length,
   };
}
