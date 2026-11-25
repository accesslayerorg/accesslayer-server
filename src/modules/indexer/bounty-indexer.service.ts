// src/modules/indexer/bounty-indexer.service.ts
// Idempotent indexer for bounty board events (#1307).

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   getChainEventId,
   IndexerChainEvent,
   processIndexerChainEvents,
} from '../../utils/indexer-event-processor.utils';

export const BOUNTY_EVENT_TYPES = new Set([
   'bounty_posted',
   'BOUNTY_POSTED',
   'BountyPosted',
   'submission_made',
   'SUBMISSION_MADE',
   'SubmissionMade',
   'bounty_awarded',
   'BOUNTY_AWARDED',
   'BountyAwarded',
   'bounty_reclaimed',
   'BOUNTY_RECLAIMED',
   'BountyReclaimed',
]);

export function isBountyEvent(event: IndexerChainEvent): boolean {
   return BOUNTY_EVENT_TYPES.has(event.eventType);
}

export async function processBountyEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!isBountyEvent(event)) return;

      const raw = event as Record<string, unknown>;
      const eventId = getChainEventId(event);
      const ledger = typeof event.ledger === 'number' ? event.ledger : 0;
      const typeLower = event.eventType.toLowerCase();
      const onChainId =
         typeof raw.bountyId === 'string' && raw.bountyId.trim().length > 0
            ? raw.bountyId.trim()
            : null;

      if (!onChainId) {
         logger.warn(
            { eventType: event.eventType, eventId },
            'Skipping bounty event without bountyId'
         );
         return;
      }

      if (typeLower === 'bounty_posted' || typeLower === 'bountyposted') {
         const keyId = String(raw.keyId ?? '');
         const creatorHandle = String(raw.creatorHandle ?? raw.handle ?? keyId);
         const creatorWallet = String(raw.creatorWallet ?? raw.creator ?? '');
         const title = String(raw.title ?? 'Untitled Bounty');
         const description =
            typeof raw.description === 'string' ? raw.description : null;
         const rewardAmount = BigInt(String(raw.rewardAmount ?? raw.amount ?? '0'));
         const maxWinners =
            typeof raw.maxWinners === 'number' && raw.maxWinners > 0
               ? raw.maxWinners
               : 1;
         const deadlineLedger =
            typeof raw.deadlineLedger === 'number'
               ? raw.deadlineLedger
               : ledger + 17280;

         await prisma.bounty.upsert({
            where: { onChainId },
            create: {
               onChainId,
               keyId,
               creatorHandle,
               creatorWallet,
               title,
               description,
               rewardAmount,
               maxWinners,
               deadlineLedger,
               txHash: event.txHash,
               eventIndex: event.eventIndex,
            },
            update: {},
         });
         return;
      }

      const bounty = await prisma.bounty.findUnique({ where: { onChainId } });
      if (!bounty) {
         logger.warn({ onChainId, eventId }, 'Bounty event for unknown bounty');
         return;
      }

      if (typeLower === 'submission_made' || typeLower === 'submissionmade') {
         const submissionId = String(raw.submissionId ?? eventId);
         const submitter = String(raw.submitter ?? raw.wallet ?? '');
         const contentUri = String(raw.contentUri ?? raw.uri ?? '');

         await prisma.bountySubmission.upsert({
            where: {
               txHash_eventIndex: {
                  txHash: event.txHash,
                  eventIndex: event.eventIndex,
               },
            },
            create: {
               bountyId: bounty.id,
               submissionId,
               submitter,
               contentUri,
               ledger,
               txHash: event.txHash,
               eventIndex: event.eventIndex,
            },
            update: {},
         });
         return;
      }

      if (typeLower === 'bounty_awarded' || typeLower === 'bountyawarded') {
         const existingAward = await prisma.bountyAward.findUnique({
            where: {
               txHash_eventIndex: {
                  txHash: event.txHash,
                  eventIndex: event.eventIndex,
               },
            },
         });
         if (existingAward) return;

         const winner = String(raw.winner ?? raw.wallet ?? '');
         const amount = BigInt(String(raw.amount ?? '0'));
         const submissionId =
            typeof raw.submissionId === 'string' ? raw.submissionId : null;

         await prisma.$transaction([
            prisma.bountyAward.create({
               data: {
                  bountyId: bounty.id,
                  submissionId,
                  winner,
                  amount,
                  ledger,
                  txHash: event.txHash,
                  eventIndex: event.eventIndex,
               },
            }),
            prisma.bounty.update({
               where: { id: bounty.id },
               data: {
                  awardedAmount: bounty.awardedAmount + amount,
                  winnersCount: bounty.winnersCount + 1,
               },
            }),
         ]);
         return;
      }

      if (typeLower === 'bounty_reclaimed' || typeLower === 'bountyreclaimed') {
         if (bounty.reclaimedAtLedger !== null) return;
         const amount =
            raw.amount !== undefined && raw.amount !== null
               ? BigInt(String(raw.amount))
               : bounty.rewardAmount - bounty.awardedAmount;

         await prisma.bounty.update({
            where: { id: bounty.id },
            data: {
               reclaimedAmount: amount > 0n ? amount : 0n,
               reclaimedAtLedger: ledger,
            },
         });
      }
   });
}
