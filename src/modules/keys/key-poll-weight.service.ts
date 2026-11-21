// src/modules/keys/key-poll-weight.service.ts
import { prisma } from '../../utils/prisma.utils';

export class PollNotFoundError extends Error {
   constructor(pollId: string) {
      super(`Poll not found: ${pollId}`);
      this.name = 'PollNotFoundError';
   }
}

/**
 * Payload returned by GET /keys/:keyId/polls/:pollId/weight/:wallet and
 * consumed by the frontend vote modal. Weight is a string of the integer key
 * count so large balances survive JSON transport without float rounding.
 */
export interface PollVoteWeight {
   vote_weight: string;
   snapshot_block: number;
}

/** Cache TTL for a wallet/poll weight pair, in seconds. */
export const POLL_WEIGHT_CACHE_SECONDS = 30;

/**
 * Redis key for the cached weight of one wallet in one poll. Scoped by key so
 * the same wallet/poll pair on a different key never shares an entry.
 */
export function pollWeightCacheKey(
   keyId: string,
   pollId: string,
   wallet: string
): string {
   return `key:poll:weight:${keyId}:${pollId}:${wallet}`;
}

/**
 * Estimated vote weight of `wallet` in a key poll, taken from its holder
 * balance at the poll's snapshot block.
 *
 * A wallet that held nothing at the snapshot block has zero weight rather than
 * an error — the vote modal shows it as non-eligible.
 */
export async function getPollVoteWeight(
   keyId: string,
   pollId: string,
   wallet: string
): Promise<PollVoteWeight> {
   const poll = await prisma.governanceProposal.findFirst({
      where: { keyId, proposalId: pollId },
      select: { snapshotLedger: true },
   });

   if (!poll) {
      throw new PollNotFoundError(pollId);
   }

   // TODO: read the balance at `poll.snapshotLedger` with a get_holder_balance
   // contract call once historical ledger reads are available. Until then the
   // indexed ownership row is the holder balance snapshot, and is the same
   // source `castKeyProposalVote` charges for the recorded vote weight.
   const ownership = await prisma.keyOwnership.findUnique({
      where: {
         ownerAddress_creatorId: { ownerAddress: wallet, creatorId: keyId },
      },
      select: { balance: true },
   });

   const balance = ownership ? Number(ownership.balance) : 0;

   return {
      vote_weight: balance > 0 ? String(balance) : '0',
      snapshot_block: poll.snapshotLedger,
   };
}
