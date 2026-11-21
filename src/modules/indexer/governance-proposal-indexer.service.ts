// src/modules/indexer/governance-proposal-indexer.service.ts
//
// Indexer event handlers for the governance proposal lifecycle.
//
// Three contract events are handled and persisted into the proposal read model
// (`GovernanceProposal`) and the votes table (`GovernanceVote`):
//
//   PROPOSAL_CREATED / ProposalCreated
//     Creates the proposal row with the on-chain metadata and zeroed tallies.
//     Idempotent via the unique (keyId, proposalId) constraint.
//
//   VOTE_CAST / VoteCast
//     Records the wallet's vote and folds its weight into the proposal tally.
//     Idempotent via the unique (keyId, proposalId, voter) constraint, so a
//     vote already written by the REST layer is never double-counted.
//
//   PROPOSAL_EXECUTED / ProposalExecuted
//     Stamps executedAt and moves the proposal to the `executed` status.
//     Idempotent by inspecting the stored execution state.
//
// Both naming conventions are accepted (`SCREAMING_SNAKE` as used by the
// existing indexer, and the `PascalCase` contract event names) so the external
// polling worker can post either shape.

import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   processIndexerChainEvents,
   IndexerChainEvent,
} from '../../utils/indexer-event-processor.utils';
import { applyVoteWeight } from '../../utils/vote-tally.utils';
import {
   DEFAULT_QUORUM_BPS,
   getSnapshotLedger,
} from '../governance/governance-proposals.service';

// ── Event type aliases ────────────────────────────────────────

export const PROPOSAL_CREATED_EVENT_TYPES = new Set([
   'PROPOSAL_CREATED',
   'ProposalCreated',
]);

export const VOTE_CAST_EVENT_TYPES = new Set(['VOTE_CAST', 'VoteCast']);

export const PROPOSAL_EXECUTED_EVENT_TYPES = new Set([
   'PROPOSAL_EXECUTED',
   'ProposalExecuted',
]);

/** Fallback voting window when the contract event omits a deadline. */
export const DEFAULT_PROPOSAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

// ── Typed event interfaces ────────────────────────────────────

export interface ProposalCreatedChainEvent extends IndexerChainEvent {
   eventType: 'PROPOSAL_CREATED' | 'ProposalCreated';
   /** Creator profile id (or handle) the proposal belongs to. */
   keyId: string;
   proposalId: string;
   title?: string;
   /** Option labels, as an array or a JSON/comma-separated string. */
   options?: string[] | string;
   /** Voting deadline (ISO-8601). `deadline` is accepted as an alias. */
   expiresAt?: string;
   deadline?: string;
   quorumBps?: number;
   snapshotLedger?: number;
   snapshotTotalWeight?: string;
   occurredAt?: string;
   createdAt?: string;
}

export interface VoteCastChainEvent extends IndexerChainEvent {
   eventType: 'VOTE_CAST' | 'VoteCast';
   keyId: string;
   proposalId: string;
   /** Voting wallet. `wallet` is accepted as an alias. */
   voter?: string;
   wallet?: string;
   optionIndex: number;
   weight: string;
   occurredAt?: string;
   createdAt?: string;
}

export interface ProposalExecutedChainEvent extends IndexerChainEvent {
   eventType: 'PROPOSAL_EXECUTED' | 'ProposalExecuted';
   keyId: string;
   proposalId: string;
   executedAt?: string;
   occurredAt?: string;
}

// ── Helpers ───────────────────────────────────────────────────

function eventId(event: IndexerChainEvent): string {
   return `${event.txHash}:${event.eventIndex}`;
}

function resolveDate(
   ...candidates: Array<string | Date | null | undefined>
): Date {
   for (const candidate of candidates) {
      if (candidate instanceof Date && !Number.isNaN(candidate.getTime())) {
         return candidate;
      }
      if (typeof candidate === 'string' && candidate.trim() !== '') {
         const parsed = new Date(candidate);
         if (!Number.isNaN(parsed.getTime())) {
            return parsed;
         }
      }
   }
   return new Date();
}

function normalizeOptions(raw: unknown): string[] {
   if (Array.isArray(raw)) {
      return raw
         .filter((value): value is string => typeof value === 'string')
         .map(value => value.trim())
         .filter(value => value.length > 0);
   }
   if (typeof raw === 'string' && raw.trim() !== '') {
      try {
         const parsed = JSON.parse(raw);
         if (Array.isArray(parsed)) {
            return normalizeOptions(parsed);
         }
      } catch {
         // Not JSON; fall through to comma splitting.
      }
      return raw
         .split(',')
         .map(value => value.trim())
         .filter(value => value.length > 0);
   }
   return [];
}

function toWeightString(value: unknown): string | null {
   if (value === null || value === undefined || value === '') return null;
   const raw = String(value).trim();
   try {
      const parsed = BigInt(raw.split('.')[0]);
      return parsed < 0n ? null : parsed.toString();
   } catch {
      return null;
   }
}

function isRecordNotFound(error: unknown): boolean {
   return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
   );
}

// ── PROPOSAL_CREATED ──────────────────────────────────────────

async function applyProposalCreated(
   event: IndexerChainEvent
): Promise<void> {
   const e = event as ProposalCreatedChainEvent;

   if (
      typeof e.keyId !== 'string' ||
      e.keyId.trim() === '' ||
      typeof e.proposalId !== 'string' ||
      e.proposalId.trim() === ''
   ) {
      logger.warn(
         { eventId: eventId(event) },
         'Skipping PROPOSAL_CREATED event due to missing keyId/proposalId'
      );
      return;
   }

   const keyId = e.keyId.trim();
   const proposalId = e.proposalId.trim();

   const existing = await prisma.governanceProposal.findUnique({
      where: { keyId_proposalId: { keyId, proposalId } },
      select: { id: true },
   });
   if (existing) {
      logger.info(
         { eventId: eventId(event), keyId, proposalId },
         'PROPOSAL_CREATED already indexed; skipping duplicate event'
      );
      return;
   }

   const options = normalizeOptions(e.options);
   const title =
      typeof e.title === 'string' && e.title.trim() !== ''
         ? e.title.trim()
         : `Governance proposal ${proposalId}`;
   const quorumBps =
      typeof e.quorumBps === 'number' && Number.isFinite(e.quorumBps)
         ? e.quorumBps
         : DEFAULT_QUORUM_BPS;
   const snapshotLedger =
      typeof e.snapshotLedger === 'number'
         ? e.snapshotLedger
         : await getSnapshotLedger();
   const snapshotTotalWeight =
      toWeightString(e.snapshotTotalWeight) ?? '0';
   const expiresAt = resolveDate(
      e.expiresAt,
      e.deadline,
      new Date(
         resolveDate(e.occurredAt, e.createdAt).getTime() +
            DEFAULT_PROPOSAL_DURATION_MS
      )
   );

   const results: Record<string, string> = {};
   for (const option of options) {
      results[option] = '0';
   }

   try {
      await prisma.governanceProposal.create({
         data: {
            keyId,
            proposalId,
            title,
            options,
            totalVotingWeight: '0',
            results,
            snapshotLedger,
            snapshotTotalWeight,
            quorumBps,
            expiresAt,
            status: 'active',
         },
      });
   } catch (error) {
      if (isRecordNotFound(error)) {
         logger.debug(
            { eventId: eventId(event), keyId, proposalId },
            'PROPOSAL_CREATED already applied; skipping replay'
         );
         return;
      }
      throw error;
   }

   logger.info(
      {
         keyId,
         proposalId,
         options,
         snapshotLedger,
         expiresAt: expiresAt.toISOString(),
         ledger: event.ledger,
         txHash: event.txHash,
      },
      'PROPOSAL_CREATED event processed'
   );
}

// ── VOTE_CAST ─────────────────────────────────────────────────

async function applyVoteCast(event: IndexerChainEvent): Promise<void> {
   const e = event as VoteCastChainEvent;

   const voter =
      typeof e.voter === 'string' && e.voter.trim() !== ''
         ? e.voter.trim()
         : typeof e.wallet === 'string' && e.wallet.trim() !== ''
           ? e.wallet.trim()
           : '';

   if (
      typeof e.keyId !== 'string' ||
      e.keyId.trim() === '' ||
      typeof e.proposalId !== 'string' ||
      e.proposalId.trim() === '' ||
      voter === ''
   ) {
      logger.warn(
         { eventId: eventId(event) },
         'Skipping VOTE_CAST event due to missing keyId/proposalId/voter'
      );
      return;
   }

   if (
      typeof e.optionIndex !== 'number' ||
      !Number.isInteger(e.optionIndex) ||
      e.optionIndex < 0
   ) {
      logger.warn(
         { eventId: eventId(event) },
         'Skipping VOTE_CAST event due to invalid optionIndex'
      );
      return;
   }

   const weight = toWeightString(e.weight);
   if (weight === null) {
      logger.warn(
         { eventId: eventId(event) },
         'Skipping VOTE_CAST event due to invalid weight'
      );
      return;
   }

   const keyId = e.keyId.trim();
   const proposalId = e.proposalId.trim();
   const optionIndex = e.optionIndex;

   const existing = await prisma.governanceVote.findUnique({
      where: {
         keyId_proposalId_voter: { keyId, proposalId, voter },
      },
      select: { id: true },
   });
   if (existing) {
      logger.info(
         { eventId: eventId(event), keyId, proposalId, voter },
         'VOTE_CAST already indexed; skipping duplicate event'
      );
      return;
   }

   const votedAt = resolveDate(e.occurredAt, e.createdAt);

   try {
      await prisma.$transaction(async tx => {
         await tx.governanceVote.create({
            data: {
               keyId,
               proposalId,
               voter,
               optionIndex,
               weight: new Decimal(weight),
               createdAt: votedAt,
            },
         });

         const proposal = await tx.governanceProposal.findUnique({
            where: { keyId_proposalId: { keyId, proposalId } },
            select: { options: true, totalVotingWeight: true, results: true },
         });

         if (!proposal) {
            logger.warn(
               { eventId: eventId(event), keyId, proposalId },
               'VOTE_CAST references unknown proposal; vote recorded without tally update'
            );
            return;
         }

         const options = normalizeOptions(proposal.options);
         if (optionIndex >= options.length) {
            logger.warn(
               {
                  eventId: eventId(event),
                  keyId,
                  proposalId,
                  optionIndex,
                  optionCount: options.length,
               },
               'VOTE_CAST optionIndex out of range; vote recorded without tally update'
            );
            return;
         }

         const tallies = applyVoteWeight(
            {
               totalVotingWeight: proposal.totalVotingWeight,
               results: (proposal.results ?? {}) as Record<string, string>,
            },
            weight,
            options[optionIndex]
         );

         await tx.governanceProposal.update({
            where: { keyId_proposalId: { keyId, proposalId } },
            data: {
               totalVotingWeight: tallies.totalVotingWeight,
               results: tallies.results,
            },
         });
      });
   } catch (error) {
      if (isRecordNotFound(error)) {
         logger.debug(
            { eventId: eventId(event), keyId, proposalId, voter },
            'VOTE_CAST already applied; skipping replay'
         );
         return;
      }
      throw error;
   }

   logger.info(
      {
         keyId,
         proposalId,
         voter,
         optionIndex,
         weight,
         ledger: event.ledger,
         txHash: event.txHash,
      },
      'VOTE_CAST event processed'
   );
}

// ── PROPOSAL_EXECUTED ─────────────────────────────────────────

async function applyProposalExecuted(
   event: IndexerChainEvent
): Promise<void> {
   const e = event as ProposalExecutedChainEvent;

   if (
      typeof e.keyId !== 'string' ||
      e.keyId.trim() === '' ||
      typeof e.proposalId !== 'string' ||
      e.proposalId.trim() === ''
   ) {
      logger.warn(
         { eventId: eventId(event) },
         'Skipping PROPOSAL_EXECUTED event due to missing keyId/proposalId'
      );
      return;
   }

   const keyId = e.keyId.trim();
   const proposalId = e.proposalId.trim();

   const proposal = await prisma.governanceProposal.findUnique({
      where: { keyId_proposalId: { keyId, proposalId } },
      select: { id: true, status: true, executedAt: true },
   });

   if (!proposal) {
      logger.warn(
         { eventId: eventId(event), keyId, proposalId },
         'PROPOSAL_EXECUTED references unknown proposal; skipping'
      );
      return;
   }

   if (proposal.executedAt !== null || proposal.status === 'executed') {
      logger.info(
         { eventId: eventId(event), keyId, proposalId },
         'PROPOSAL_EXECUTED already indexed; skipping duplicate event'
      );
      return;
   }

   const executedAt = resolveDate(e.executedAt, e.occurredAt);

   await prisma.governanceProposal.update({
      where: { keyId_proposalId: { keyId, proposalId } },
      data: { status: 'executed', executedAt, closedAt: executedAt },
   });

   logger.info(
      {
         keyId,
         proposalId,
         executedAt: executedAt.toISOString(),
         ledger: event.ledger,
         txHash: event.txHash,
      },
      'PROPOSAL_EXECUTED event processed'
   );
}

// ── Public entry points ───────────────────────────────────────

/** Indexes PROPOSAL_CREATED / ProposalCreated events. */
export async function processGovernanceProposalCreatedEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (PROPOSAL_CREATED_EVENT_TYPES.has(event.eventType)) {
         await applyProposalCreated(event);
      }
   });
}

/** Indexes VOTE_CAST / VoteCast events. */
export async function processGovernanceVoteCastEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (VOTE_CAST_EVENT_TYPES.has(event.eventType)) {
         await applyVoteCast(event);
      }
   });
}

/** Indexes PROPOSAL_EXECUTED / ProposalExecuted events. */
export async function processGovernanceProposalExecutedEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (PROPOSAL_EXECUTED_EVENT_TYPES.has(event.eventType)) {
         await applyProposalExecuted(event);
      }
   });
}

/**
 * Indexes a mixed batch of governance lifecycle events in order. Used by the
 * shared indexer pipeline dispatcher so a single batch may contain a
 * PROPOSAL_CREATED immediately followed by its VOTE_CAST events.
 */
export async function processGovernanceProposalEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (PROPOSAL_CREATED_EVENT_TYPES.has(event.eventType)) {
         await applyProposalCreated(event);
         return;
      }
      if (VOTE_CAST_EVENT_TYPES.has(event.eventType)) {
         await applyVoteCast(event);
         return;
      }
      if (PROPOSAL_EXECUTED_EVENT_TYPES.has(event.eventType)) {
         await applyProposalExecuted(event);
      }
   });
}
