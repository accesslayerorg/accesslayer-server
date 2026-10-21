// src/modules/keys/key-polls.service.ts
//
// Read model for key community polls (#1174), backed by GovernanceProposal
// and GovernanceVote rows indexed from on-chain poll events.
//
// - GET /keys/:key_id/polls                     — paginated active & closed polls with tally and time remaining
// - GET /keys/:key_id/polls/:poll_id            — single poll with per-option results and optional wallet vote
// - GET /keys/:key_id/polls/:poll_id/weight/:wallet — wallet vote weight from snapshot (key-poll-weight.service.ts)
//
// Responses are cached in Redis for 30s and invalidated on PollVoteCast and
// PollClosed events.

import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheInvalidate,
   cacheSetJson,
} from '../../utils/redis.utils';
import {
   KEY_POLLS_CACHE_TTL_SECONDS,
   keyPollDetailCacheKey,
   keyPollsCachePattern,
   keyPollsListCacheKey,
} from '../../constants/redis.constants';
import { buildPaginationMetadata } from '../../utils/indexer-event-fields.utils';
import { PaginationMetadata } from '../../utils/api-response.utils';
import { PollNotFoundError } from './key-poll-weight.service';

export { PollNotFoundError };

export type PollFilterStatus = 'active' | 'closed';

export interface KeyPollOptionResult {
   index: number;
   option: string;
   votes: string;
   percentage: number;
}

export interface KeyPollWalletVote {
   voter: string;
   option_index: number;
   option: string;
   weight: string;
}

export interface KeyPollItem {
   poll_id: string;
   key_id: string;
   title: string;
   options: string[];
   status: 'active' | 'closed';
   raw_status: string;
   tally: Record<string, string>;
   results: Record<string, string>;
   option_results: KeyPollOptionResult[];
   total_voting_weight: string;
   snapshot_block: number;
   expires_at: string;
   closed_at: string | null;
   time_remaining_seconds: number;
}

export interface KeyPollDetail extends KeyPollItem {
   wallet_vote: KeyPollWalletVote | null;
}

export interface KeyPollsPage {
   key_id: string;
   polls: KeyPollItem[];
   items: KeyPollItem[];
   pagination: PaginationMetadata;
}

export async function invalidateKeyPollsCache(keyId: string): Promise<void> {
   await cacheInvalidate(
      keyPollsCachePattern(keyId),
      `key:poll:weight:${keyId}:*`
   );
}

function buildOptionResults(
   options: string[],
   rawResults: Record<string, string>,
   totalVotingWeight: string
): {
   normalizedResults: Record<string, string>;
   optionResults: KeyPollOptionResult[];
} {
   const totalNum = Number(totalVotingWeight) || 0;
   const normalizedResults: Record<string, string> = {};
   const optionResults: KeyPollOptionResult[] = options.map((opt, index) => {
      const votes = String(rawResults?.[opt] ?? '0');
      normalizedResults[opt] = votes;
      const votesNum = Number(votes) || 0;
      const percentage =
         totalNum > 0 ? Math.round((votesNum / totalNum) * 10000) / 100 : 0;
      return {
         index,
         option: opt,
         votes,
         percentage,
      };
   });

   return { normalizedResults, optionResults };
}

export function mapProposalToPollItem(
   row: {
      keyId: string;
      proposalId: string;
      title: string;
      options: unknown;
      totalVotingWeight: string;
      results: unknown;
      snapshotLedger: number;
      expiresAt: Date;
      closedAt: Date | null;
      status: string;
   },
   now: Date = new Date()
): KeyPollItem {
   const options = Array.isArray(row.options) ? (row.options as string[]) : [];
   const rawResults =
      row.results && typeof row.results === 'object'
         ? (row.results as Record<string, string>)
         : {};

   const isExpired = row.expiresAt.getTime() <= now.getTime();
   const isClosed = row.status !== 'active' || row.closedAt !== null || isExpired;
   const timeRemainingSeconds = isClosed
      ? 0
      : Math.max(0, Math.floor((row.expiresAt.getTime() - now.getTime()) / 1000));

   const { normalizedResults, optionResults } = buildOptionResults(
      options,
      rawResults,
      row.totalVotingWeight
   );

   return {
      poll_id: row.proposalId,
      key_id: row.keyId,
      title: row.title,
      options,
      status: isClosed ? 'closed' : 'active',
      raw_status: row.status,
      tally: normalizedResults,
      results: normalizedResults,
      option_results: optionResults,
      total_voting_weight: row.totalVotingWeight,
      snapshot_block: row.snapshotLedger,
      expires_at: row.expiresAt.toISOString(),
      closed_at: row.closedAt ? row.closedAt.toISOString() : null,
      time_remaining_seconds: timeRemainingSeconds,
   };
}

/**
 * Lists paginated active and closed community polls for a key (#1174).
 */
export async function listKeyPolls(
   keyId: string,
   opts: {
      status?: PollFilterStatus;
      page?: number;
      limit?: number;
      now?: Date;
   } = {}
): Promise<KeyPollsPage> {
   const page = Math.max(1, Math.trunc(opts.page ?? 1));
   const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? 20)), 100);
   const statusKey = opts.status ?? 'all';
   const cacheKey = keyPollsListCacheKey(keyId, statusKey, page, limit);

   try {
      const cached = await cacheGetJson<KeyPollsPage>(cacheKey);
      if (cached !== null) {
         return cached;
      }
   } catch {
      // Fall through to DB on Redis failure.
   }

   const now = opts.now ?? new Date();
   const where: Record<string, unknown> = { keyId };
   if (opts.status === 'active') {
      where.status = 'active';
      where.expiresAt = { gt: now };
   } else if (opts.status === 'closed') {
      where.OR = [{ status: { not: 'active' } }, { expiresAt: { lte: now } }];
   }

   const skip = (page - 1) * limit;
   const [rows, totalCount] = await Promise.all([
      prisma.governanceProposal.findMany({
         where,
         orderBy:
            opts.status === 'closed'
               ? { closedAt: 'desc' }
               : { createdAt: 'desc' },
         skip,
         take: limit,
      }),
      prisma.governanceProposal.count({ where }),
   ]);

   const polls = rows.map(row => mapProposalToPollItem(row, now));
   const result: KeyPollsPage = {
      key_id: keyId,
      polls,
      items: polls,
      pagination: buildPaginationMetadata({ page, limit, totalCount }),
   };

   try {
      await cacheSetJson(cacheKey, result, KEY_POLLS_CACHE_TTL_SECONDS);
   } catch {
      // Cache write failure is non-critical.
   }

   return result;
}

/**
 * Returns a single poll with per-option results and the caller/query wallet's
 * cast vote when available (#1174). Throws PollNotFoundError if not found.
 */
export async function getKeyPollDetail(
   keyId: string,
   pollId: string,
   wallet?: string,
   now: Date = new Date()
): Promise<KeyPollDetail> {
   const normalizedWallet = wallet?.trim() || undefined;
   const cacheKey = keyPollDetailCacheKey(
      keyId,
      pollId,
      normalizedWallet ?? '_anon'
   );

   try {
      const cached = await cacheGetJson<KeyPollDetail>(cacheKey);
      if (cached !== null) {
         return cached;
      }
   } catch {
      // Fall through to DB on Redis failure.
   }

   const row = await prisma.governanceProposal.findFirst({
      where: { keyId, proposalId: pollId },
   });

   if (!row) {
      throw new PollNotFoundError(pollId);
   }

   const item = mapProposalToPollItem(row, now);
   let walletVote: KeyPollWalletVote | null = null;

   if (normalizedWallet) {
      const voteRow = await prisma.governanceVote.findUnique({
         where: {
            keyId_proposalId_voter: {
               keyId,
               proposalId: pollId,
               voter: normalizedWallet,
            },
         },
      });
      if (voteRow) {
         walletVote = {
            voter: voteRow.voter,
            option_index: voteRow.optionIndex,
            option: item.options[voteRow.optionIndex] ?? '',
            weight: String(voteRow.weight),
         };
      }
   }

   const detail: KeyPollDetail = {
      ...item,
      wallet_vote: walletVote,
   };

   try {
      await cacheSetJson(cacheKey, detail, KEY_POLLS_CACHE_TTL_SECONDS);
   } catch {
      // Cache write failure is non-critical.
   }

   return detail;
}
