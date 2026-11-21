// src/modules/indexer/governance-escalation-indexer.service.ts
//
// Syncs governance proposal quorum escalation state (#935) from
// ProposalExtended contract events: increments escalationCount, moves
// expiresAt to the new (extended) deadline, and stamps escalatedAt.
//
// When escalationCount reaches maxEscalations, logs a structured admin-alert
// entry (`type: 'governance_escalation_max_reached'`) — the codebase has no
// dedicated admin-notification utility, so a structured log is the
// house-standard way to surface this for operators/alerting pipelines.

import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { buildLogFields } from '../../utils/log-fields.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';

export interface ProposalExtendedChainEvent extends IndexerChainEvent {
   eventType: 'PROPOSAL_EXTENDED';
   keyId: string;
   proposalId: string;
   /** New deadline (ISO-8601) after this escalation. */
   newDeadline: string;
}

function isValidEvent(
   event: IndexerChainEvent
): event is ProposalExtendedChainEvent {
   const e = event as Partial<ProposalExtendedChainEvent>;
   return (
      event.eventType === 'PROPOSAL_EXTENDED' &&
      typeof e.keyId === 'string' &&
      e.keyId.length > 0 &&
      typeof e.proposalId === 'string' &&
      e.proposalId.length > 0 &&
      typeof e.newDeadline === 'string' &&
      !isNaN(new Date(e.newDeadline).getTime())
   );
}

/**
 * Applies PROPOSAL_EXTENDED events to GovernanceProposal escalation fields.
 *
 * Each event is recorded in GovernanceEscalationEventLog inside the same
 * transaction as the proposal update; a replayed event violates the
 * (txHash, eventIndex) unique constraint and is skipped.
 */
export async function processGovernanceEscalationEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (event.eventType !== 'PROPOSAL_EXTENDED') {
         return;
      }

      if (!isValidEvent(event)) {
         logger.warn(
            buildLogFields({
               type: 'governance_escalation_event_invalid',
               eventId: `${event.txHash}:${event.eventIndex}`,
            }),
            'Skipping governance escalation event with missing or invalid fields'
         );
         return;
      }

      const { keyId, proposalId, newDeadline } = event;
      const newDeadlineDate = new Date(newDeadline);

      try {
         await prisma.$transaction(async tx => {
            await tx.governanceEscalationEventLog.create({
               data: {
                  keyId,
                  proposalId,
                  ledger:
                     typeof event.ledger === 'number' ? event.ledger : null,
                  txHash: String(event.txHash),
                  eventIndex: Number(event.eventIndex),
               },
            });

            const proposal = await tx.governanceProposal.findUnique({
               where: { keyId_proposalId: { keyId, proposalId } },
            });

            if (!proposal) {
               logger.warn(
                  buildLogFields({
                     type: 'governance_escalation_proposal_not_found',
                     keyId,
                     proposalId,
                     eventId: `${event.txHash}:${event.eventIndex}`,
                  }),
                  'ProposalExtended event references unknown proposal'
               );
               return;
            }

            const nextEscalationCount = proposal.escalationCount + 1;
            const originalDeadline =
               proposal.originalDeadline ?? proposal.expiresAt;

            await tx.governanceProposal.update({
               where: { keyId_proposalId: { keyId, proposalId } },
               data: {
                  escalationCount: nextEscalationCount,
                  originalDeadline,
                  extendedDeadline: newDeadlineDate,
                  expiresAt: newDeadlineDate,
                  escalatedAt: new Date(),
               },
            });

            if (nextEscalationCount >= proposal.maxEscalations) {
               logger.warn(
                  buildLogFields({
                     type: 'governance_escalation_max_reached',
                     keyId,
                     proposalId,
                     escalationCount: nextEscalationCount,
                     maxEscalations: proposal.maxEscalations,
                     extendedDeadline: newDeadlineDate,
                  }),
                  'Governance proposal reached maximum escalations; admin attention required'
               );
            }
         });
      } catch (error) {
         if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
         ) {
            logger.debug(
               { eventId: `${event.txHash}:${event.eventIndex}` },
               'Governance escalation event already applied; skipping replay'
            );
            return;
         }
         throw error;
      }
   });
}
