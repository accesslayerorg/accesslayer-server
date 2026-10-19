// src/modules/indexer/campaign-indexer.service.ts
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
   getChainEventId,
} from '../../utils/indexer-event-processor.utils';
import { invalidateCampaignCache } from '../campaigns/campaign.service';
import { Decimal } from '@prisma/client/runtime/library';

export interface CampaignCreatedChainEvent extends IndexerChainEvent {
   eventType: 'CampaignCreated';
   campaignId: string;
   title: string;
   description?: string;
   status?: string;
   criteria?: string | object;
   rewardPool: string | number;
   startsAt?: string;
   endsAt?: string;
}

export interface WalletQualifiedChainEvent extends IndexerChainEvent {
   eventType: 'WalletQualified';
   campaignId: string;
   wallet: string;
   criteriaProgress?: string | number;
   criteriaScore?: string | number;
   claimableAmount?: string | number;
}

export interface RewardClaimedChainEvent extends IndexerChainEvent {
   eventType: 'RewardClaimed';
   campaignId: string;
   wallet: string;
   amount: string | number;
}

export type CampaignChainEvent =
   | CampaignCreatedChainEvent
   | WalletQualifiedChainEvent
   | RewardClaimedChainEvent;

export async function processCampaignEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (
         event.eventType !== 'CampaignCreated' &&
         event.eventType !== 'WalletQualified' &&
         event.eventType !== 'RewardClaimed'
      ) {
         return;
      }

      if (event.eventType === 'CampaignCreated') {
         const createdEvent = event as CampaignCreatedChainEvent;
         const { campaignId, title, description, status, criteria, rewardPool, startsAt, endsAt } = createdEvent;

         if (!campaignId || !title) {
            logger.warn(
               { eventId: getChainEventId(event) },
               'Skipping CampaignCreated event with missing required fields'
            );
            return;
         }

         const criteriaStr = typeof criteria === 'object' ? JSON.stringify(criteria) : (criteria || '{}');
         const rewardPoolDec = new Decimal(rewardPool || 0);
         const startsAtDate = startsAt ? new Date(startsAt) : new Date();
         const endsAtDate = endsAt ? new Date(endsAt) : null;

         await prisma.campaign.upsert({
            where: { campaignId },
            create: {
               campaignId,
               title,
               description: description || null,
               status: status || 'active',
               criteria: criteriaStr,
               rewardPool: rewardPoolDec,
               startsAt: startsAtDate,
               endsAt: endsAtDate,
            },
            update: {
               title,
               description: description || null,
               status: status || 'active',
               criteria: criteriaStr,
               rewardPool: rewardPoolDec,
               startsAt: startsAtDate,
               endsAt: endsAtDate,
            },
         });

         await invalidateCampaignCache(campaignId);
      } else if (event.eventType === 'WalletQualified') {
         const qualifiedEvent = event as WalletQualifiedChainEvent;
         const { campaignId, wallet, criteriaProgress, criteriaScore, claimableAmount } = qualifiedEvent;

         if (!campaignId || !wallet) {
            logger.warn(
               { eventId: getChainEventId(event) },
               'Skipping WalletQualified event with missing campaignId or wallet'
            );
            return;
         }

         const progressDec = new Decimal(criteriaProgress || 0);
         const scoreDec = new Decimal(criteriaScore || 0);
         const claimableDec = new Decimal(claimableAmount || 0);

         await prisma.campaignEligibility.upsert({
            where: {
               campaignId_wallet: {
                  campaignId,
                  wallet,
               },
            },
            create: {
               campaignId,
               wallet,
               isEligible: true,
               criteriaProgress: progressDec,
               criteriaScore: scoreDec,
               claimableAmount: claimableDec,
               claimedAmount: new Decimal(0),
            },
            update: {
               isEligible: true,
               criteriaProgress: progressDec,
               criteriaScore: scoreDec,
               claimableAmount: claimableDec,
            },
         });

         await invalidateCampaignCache(campaignId, wallet);
      } else if (event.eventType === 'RewardClaimed') {
         const claimedEvent = event as RewardClaimedChainEvent;
         const { campaignId, wallet, amount } = claimedEvent;

         if (!campaignId || !wallet) {
            logger.warn(
               { eventId: getChainEventId(event) },
               'Skipping RewardClaimed event with missing campaignId or wallet'
            );
            return;
         }

         const claimDelta = new Decimal(amount || 0);

         const existing = await prisma.campaignEligibility.findUnique({
            where: {
               campaignId_wallet: {
                  campaignId,
                  wallet,
               },
            },
         });

         if (existing) {
            const newClaimable = existing.claimableAmount.minus(claimDelta);
            const clampedClaimable = newClaimable.isNegative() ? new Decimal(0) : newClaimable;
            const newClaimed = existing.claimedAmount.plus(claimDelta);

            await prisma.campaignEligibility.update({
               where: {
                  campaignId_wallet: {
                     campaignId,
                     wallet,
                  },
               },
               data: {
                  claimableAmount: clampedClaimable,
                  claimedAmount: newClaimed,
               },
            });
         }

         await invalidateCampaignCache(campaignId, wallet);
      }
   });
}
