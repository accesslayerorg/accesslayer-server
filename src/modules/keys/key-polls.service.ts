import type { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import { Decimal } from '@prisma/client/runtime/library';

/**
 * Poll reads are cached for 30s. PollVoteCast and PollClosed events invalidate
 * every `key:polls*:<keyId>:*` entry (see key-poll-indexer.service.ts).
 */
export const KEY_POLLS_CACHE_SECONDS = 30;
export const KEY_POLLS_DEFAULT_LIMIT = 20;
export const KEY_POLLS_MAX_LIMIT = 100;

export type KeyPollStatusFilter = 'active' | 'closed' | 'all';

export class KeyPollNotFoundError extends Error {
   readonly resource: 'Key' | 'Poll';

   constructor(keyId: string, pollId?: string) {
      super(
         pollId
            ? `Poll not found: ${keyId}/${pollId}`
            : `Key not found: ${keyId}`
      );
      this.resource = pollId ? 'Poll' : 'Key';
      this.name = pollId ? 'PollNotFoundError' : 'KeyNotFoundError';
   }
}

/** Raised when a pagination cursor does not name a poll under the key. */
export class InvalidKeyPollCursorError extends Error {
   constructor(cursor: string) {
      super(`Invalid poll cursor: ${cursor}`);
      this.name = 'InvalidKeyPollCursorError';
   }
}

export interface PollVoteStatus {
   wallet: string;
   voted: boolean;
   vote: { optionIndex: number; option: string; weight: string } | null;
}

export interface PollResult {
   pollId: string;
   question: string;
   options: string[];
   status: 'active' | 'closed';
   totalVotes: number;
   totalVotingWeight: string;
   results: Record<string, string>;
   expiresAt: Date;
   closedAt: Date | null;
   /** Whole seconds until the poll expires; 0 once it is closed. */
   timeRemainingSeconds: number;
}

export interface PollDetail extends PollResult {
   optionResults: Array<{
      optionIndex: number;
      option: string;
      votes: number;
      weight: string;
   }>;
   /** Present only when the request names a wallet. */
   walletVote?: PollVoteStatus;
}

export interface KeyPollsPageOptions {
   status?: KeyPollStatusFilter;
   cursor?: string;
   limit?: number;
}

export interface KeyPollsPage {
   items: PollResult[];
   /** The pollId to pass as `cursor` for the next page, or null at the end. */
   nextCursor: string | null;
}

function normalizeOptions(value: unknown): string[] {
   return Array.isArray(value)
      ? value.filter((option): option is string => typeof option === 'string')
      : [];
}

function normalizeLimit(limit: number | undefined): number {
   if (limit === undefined || !Number.isFinite(limit)) {
      return KEY_POLLS_DEFAULT_LIMIT;
   }
   return Math.min(Math.max(Math.trunc(limit), 1), KEY_POLLS_MAX_LIMIT);
}

/**
 * Filter for a status view. A poll counts as closed when the indexer has seen
 * PollClosed or when its expiry has passed, so both checks are applied.
 */
export function pollStatusWhere(
   status: KeyPollStatusFilter,
   now: Date
): Prisma.KeyPollWhereInput {
   if (status === 'active') {
      return { status: { not: 'closed' }, expiresAt: { gt: now } };
   }
   if (status === 'closed') {
      return { OR: [{ status: 'closed' }, { expiresAt: { lte: now } }] };
   }
   return {};
}

async function getPollResults(
   poll: {
      keyId: string;
      pollId: string;
      question: string;
      options: unknown;
      status: string;
      expiresAt: Date;
      closedAt: Date | null;
   },
   includeOptionResults: boolean
): Promise<PollResult | PollDetail> {
   const options = normalizeOptions(poll.options);
   const groupedVotes = await prisma.keyPollVote.groupBy({
      by: ['optionIndex'],
      where: { keyId: poll.keyId, pollId: poll.pollId },
      _count: { _all: true },
      _sum: { weight: true },
   });
   const results: Record<string, string> = {};
   const optionResults = options.map((option, optionIndex) => {
      const grouped = groupedVotes.find(row => row.optionIndex === optionIndex);
      const weight = grouped?._sum.weight?.toString() ?? '0';
      results[option] = weight;
      return {
         optionIndex,
         option,
         votes: grouped?._count._all ?? 0,
         weight,
      };
   });
   const totalWeight = optionResults.reduce(
      (total, result) => total.plus(result.weight),
      new Decimal(0)
   );
   const now = Date.now();
   const closed = poll.status === 'closed' || poll.expiresAt.getTime() <= now;
   const response: PollResult = {
      pollId: poll.pollId,
      question: poll.question,
      options,
      status: closed ? 'closed' : 'active',
      totalVotes: optionResults.reduce(
         (total, result) => total + result.votes,
         0
      ),
      totalVotingWeight: totalWeight.toString(),
      results,
      expiresAt: poll.expiresAt,
      closedAt: poll.closedAt,
      timeRemainingSeconds: closed
         ? 0
         : Math.max(0, Math.ceil((poll.expiresAt.getTime() - now) / 1000)),
   };
   return includeOptionResults ? { ...response, optionResults } : response;
}

async function requireKey(keyId: string): Promise<void> {
   const key = await prisma.creatorProfile.findUnique({
      where: { id: keyId },
      select: { id: true },
   });
   if (!key) throw new KeyPollNotFoundError(keyId);
}

/**
 * One page of a key's polls, newest expiry first. `cursor` is the pollId of
 * the last poll on the previous page.
 */
export async function getKeyPolls(
   keyId: string,
   options: KeyPollsPageOptions = {}
): Promise<KeyPollsPage> {
   const status = options.status ?? 'all';
   const limit = normalizeLimit(options.limit);
   const cursor = options.cursor ?? null;
   const cacheKey = `key:polls:${keyId}:list:${status}:${cursor ?? 'first'}:${limit}`;
   const cached = await cacheGetJson<KeyPollsPage>(cacheKey);
   if (cached !== null) return cached;

   await requireKey(keyId);

   let cursorArgs:
      | { cursor: { keyId_pollId: { keyId: string; pollId: string } }; skip: number }
      | undefined;
   if (cursor !== null) {
      const cursorPoll = await prisma.keyPoll.findUnique({
         where: { keyId_pollId: { keyId, pollId: cursor } },
         select: { pollId: true },
      });
      if (!cursorPoll) throw new InvalidKeyPollCursorError(cursor);
      cursorArgs = {
         cursor: { keyId_pollId: { keyId, pollId: cursor } },
         skip: 1,
      };
   }

   // Fetch one extra row to learn whether another page exists.
   const rows = await prisma.keyPoll.findMany({
      where: { keyId, ...pollStatusWhere(status, new Date()) },
      orderBy: [{ expiresAt: 'desc' }, { pollId: 'asc' }],
      take: limit + 1,
      ...cursorArgs,
   });
   const hasMore = rows.length > limit;
   const pageRows = hasMore ? rows.slice(0, limit) : rows;
   const items = await Promise.all(
      pageRows.map(poll => getPollResults(poll, false) as Promise<PollResult>)
   );
   const page: KeyPollsPage = {
      items,
      nextCursor: hasMore ? pageRows[pageRows.length - 1].pollId : null,
   };
   await cacheSetJson(cacheKey, page, KEY_POLLS_CACHE_SECONDS);
   return page;
}

/**
 * Poll detail with per-option results. When `wallet` is given, the wallet's
 * vote is attached as `walletVote`. The vote lookup has its own cache entry,
 * so the detail entry does not vary by wallet.
 */
export async function getKeyPoll(
   keyId: string,
   pollId: string,
   wallet?: string
): Promise<PollDetail> {
   const cacheKey = `key:polls:${keyId}:${pollId}:detail`;
   let detail = await cacheGetJson<PollDetail>(cacheKey);
   if (detail === null) {
      await requireKey(keyId);
      const poll = await prisma.keyPoll.findUnique({
         where: { keyId_pollId: { keyId, pollId } },
      });
      if (!poll) throw new KeyPollNotFoundError(keyId, pollId);
      detail = (await getPollResults(poll, true)) as PollDetail;
      await cacheSetJson(cacheKey, detail, KEY_POLLS_CACHE_SECONDS);
   }

   if (wallet === undefined) return detail;
   const walletVote = await getKeyPollVote(keyId, pollId, wallet);
   return { ...detail, walletVote };
}

export async function getKeyPollVote(
   keyId: string,
   pollId: string,
   wallet: string
): Promise<PollVoteStatus> {
   const cacheKey = `key:polls:${keyId}:${pollId}:votes:${wallet}`;
   const cached = await cacheGetJson<PollVoteStatus>(cacheKey);
   if (cached !== null) return cached;

   await requireKey(keyId);
   const poll = await prisma.keyPoll.findUnique({
      where: { keyId_pollId: { keyId, pollId } },
      select: { options: true },
   });
   if (!poll) throw new KeyPollNotFoundError(keyId, pollId);
   const vote = await prisma.keyPollVote.findUnique({
      where: { keyId_pollId_wallet: { keyId, pollId, wallet } },
      select: { optionIndex: true, weight: true },
   });
   const options = normalizeOptions(poll.options);
   const result: PollVoteStatus = {
      wallet,
      voted: vote !== null,
      vote:
         vote && options[vote.optionIndex] !== undefined
            ? {
                 optionIndex: vote.optionIndex,
                 option: options[vote.optionIndex],
                 weight: vote.weight.toString(),
              }
            : null,
   };
   await cacheSetJson(cacheKey, result, KEY_POLLS_CACHE_SECONDS);
   return result;
}
