// src/modules/indexer/poll-indexer.service.ts
// Indexes PollVoteCast and PollClosed contract events (#1174) and invalidates
// the 30s key community poll caches.

import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   IndexerChainEvent,
   processIndexerChainEvents,
} from '../../utils/indexer-event-processor.utils';
import { eventOccurredAt } from '../../utils/indexer-event-fields.utils';
import { applyVoteWeight } from '../../utils/vote-tally.utils';
import { invalidateKeyPollsCache } from '../keys/key-polls.service';

export const POLL_EVENT_TYPES: ReadonlySet<string> = new Set([
   'PollVoteCast',
   'POLL_VOTE_CAST',
   'PollClosed',
   'POLL_CLOSED',
]);

function readString(
   raw: Record<string, unknown>,
   ...names: string[]
): string | null {
   for (const name of names) {
      const value = raw[name];
      if (typeof value === 'string' && value.trim() !== '') {
         return value.trim();
      }
   }
   return null;
}

export async function processPollEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!POLL_EVENT_TYPES.has(event.eventType)) {
         return;
      }

      const raw = event as Record<string, unknown>;
      const keyId = readString(raw, 'keyId', 'key_id', 'creatorId', 'creator_id');
      const pollId = readString(
         raw,
         'pollId',
         'poll_id',
         'proposalId',
         'proposal_id'
      );

      if (!keyId || !pollId) {
         logger.warn(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
               eventType: event.eventType,
            },
            'Skipping poll event with missing keyId or pollId'
         );
         return;
      }

      const isClosedEvent =
         event.eventType === 'PollClosed' || event.eventType === 'POLL_CLOSED';

      if (isClosedEvent) {
         const occurredAt = eventOccurredAt(event);
         const existing = await prisma.governanceProposal.findFirst({
            where: { keyId, proposalId: pollId },
            select: { id: true, status: true },
         });
         if (existing && existing.status === 'active') {
            await prisma.governanceProposal.update({
               where: { id: existing.id },
               data: {
                  status: 'closed',
                  closedAt: occurredAt,
               },
            });
         }
         await invalidateKeyPollsCache(keyId);
         return;
      }

      // PollVoteCast / POLL_VOTE_CAST
      const voter = readString(raw, 'voter', 'wallet', 'actor');
      const optionIndex = Number(
         raw.optionIndex ?? raw.option_index ?? raw.option ?? 0
      );
      const weightStr = String(raw.weight ?? raw.vote_weight ?? '1');

      if (voter && Number.isInteger(optionIndex) && optionIndex >= 0) {
         const proposal = await prisma.governanceProposal.findFirst({
            where: { keyId, proposalId: pollId },
         });

         if (proposal) {
            const existingVote = await prisma.governanceVote.findUnique({
               where: {
                  keyId_proposalId_voter: {
                     keyId,
                     proposalId: pollId,
                     voter,
                  },
               },
            });

            if (!existingVote) {
               const options = Array.isArray(proposal.options)
                  ? (proposal.options as string[])
                  : [];
               const optionLabel =
                  options[optionIndex] ?? `option_${optionIndex}`;
               const updated = applyVoteWeight(
                  {
                     totalVotingWeight: proposal.totalVotingWeight,
                     results: (proposal.results ?? {}) as Record<
                        string,
                        string
                     >,
                  },
                  weightStr,
                  optionLabel
               );

               await prisma.$transaction([
                  prisma.governanceProposal.update({
                     where: { id: proposal.id },
                     data: {
                        totalVotingWeight: updated.totalVotingWeight,
                        results: updated.results,
                     },
                  }),
                  prisma.governanceVote.create({
                     data: {
                        keyId,
                        proposalId: pollId,
                        voter,
                        optionIndex,
                        weight: new Decimal(weightStr),
                     },
                  }),
               ]);
            }
         }
      }

      await invalidateKeyPollsCache(keyId);
   });
}
