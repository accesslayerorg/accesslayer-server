import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import { Decimal } from '@prisma/client/runtime/library';

export const KEY_POLLS_CACHE_SECONDS = 30;

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

interface PollVoteStatus {
   wallet: string;
   voted: boolean;
   vote: { optionIndex: number; option: string; weight: string } | null;
}

interface PollResult {
   pollId: string;
   question: string;
   options: string[];
   status: 'active' | 'closed';
   totalVotes: number;
   totalVotingWeight: string;
   results: Record<string, string>;
   expiresAt: Date;
   closedAt: Date | null;
}

interface PollDetail extends PollResult {
   optionResults: Array<{
      optionIndex: number;
      option: string;
      votes: number;
      weight: string;
   }>;
}

function normalizeOptions(value: unknown): string[] {
   return Array.isArray(value)
      ? value.filter((option): option is string => typeof option === 'string')
      : [];
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
   const response: PollResult = {
      pollId: poll.pollId,
      question: poll.question,
      options,
      status:
         poll.status === 'closed' || poll.expiresAt.getTime() <= Date.now()
            ? 'closed'
            : 'active',
      totalVotes: optionResults.reduce(
         (total, result) => total + result.votes,
         0
      ),
      totalVotingWeight: totalWeight.toString(),
      results,
      expiresAt: poll.expiresAt,
      closedAt: poll.closedAt,
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

export async function getKeyPolls(keyId: string): Promise<PollResult[]> {
   const cacheKey = `key:polls:${keyId}:list`;
   const cached = await cacheGetJson<PollResult[]>(cacheKey);
   if (cached !== null) return cached;

   await requireKey(keyId);
   const polls = await prisma.keyPoll.findMany({
      where: { keyId },
      orderBy: [{ expiresAt: 'desc' }, { pollId: 'asc' }],
   });
   const results = await Promise.all(
      polls.map(poll => getPollResults(poll, false) as Promise<PollResult>)
   );
   await cacheSetJson(cacheKey, results, KEY_POLLS_CACHE_SECONDS);
   return results;
}

export async function getKeyPoll(
   keyId: string,
   pollId: string
): Promise<PollDetail> {
   const cacheKey = `key:polls:${keyId}:${pollId}:detail`;
   const cached = await cacheGetJson<PollDetail>(cacheKey);
   if (cached !== null) return cached;

   await requireKey(keyId);
   const poll = await prisma.keyPoll.findUnique({
      where: { keyId_pollId: { keyId, pollId } },
   });
   if (!poll) throw new KeyPollNotFoundError(keyId, pollId);
   const result = (await getPollResults(poll, true)) as PollDetail;
   await cacheSetJson(cacheKey, result, KEY_POLLS_CACHE_SECONDS);
   return result;
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
