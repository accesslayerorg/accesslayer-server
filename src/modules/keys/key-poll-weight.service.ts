// src/modules/keys/key-poll-weight.service.ts
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';
import { KeyNotFoundError } from './key-fees.service';

export { KeyNotFoundError };

export class PollNotFoundError extends Error {
   constructor(pollId: string) {
      super(`Poll not found: ${pollId}`);
      this.name = 'PollNotFoundError';
   }
}

export interface KeyPollWeightResponse {
   key_id: string;
   poll_id: string;
   wallet: string;
   vote_weight: string;
   snapshot_block: number;
}

export const POLL_WEIGHT_CACHE_TTL_SECONDS = 60;

export function getKeyPollWeightCacheKey(
   keyId: string,
   pollId: string,
   wallet: string
): string {
   return `keys:poll:${keyId}:${pollId}:weight:${wallet}`;
}

export async function invalidateKeyPollWeightCache(
   keyId: string,
   pollId: string,
   wallet: string
): Promise<void> {
   try {
      await cacheInvalidate(getKeyPollWeightCacheKey(keyId, pollId, wallet));
   } catch (error) {
      logger.warn({ error, keyId, pollId, wallet }, 'Failed to invalidate key poll weight cache');
   }
}

/**
 * Return a wallet's estimated vote weight for a key poll, computed from the
 * holder balance snapshot at poll creation block.
 *
 * - Returns vote_weight and snapshot_block
 * - Returns zero weight ('0') for wallets with no balance at snapshot block
 * - Caches result in Redis for 60 seconds per wallet/poll pair
 */
export async function getKeyPollWeight(
   keyId: string,
   pollId: string,
   wallet: string
): Promise<KeyPollWeightResponse> {
   const cacheKey = getKeyPollWeightCacheKey(keyId, pollId, wallet);

   const cached = await cacheGetJson<KeyPollWeightResponse>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyId }, { handle: keyId }] },
      select: { id: true },
   });

   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const proposal = await prisma.governanceProposal.findFirst({
      where: {
         keyId: creator.id,
         OR: [{ proposalId: pollId }, { id: pollId }],
      },
      select: { proposalId: true, snapshotLedger: true },
   });

   if (!proposal) {
      throw new PollNotFoundError(pollId);
   }

   const snapshot = await prisma.governanceVotingSnapshot.findUnique({
      where: {
         keyId_proposalId_wallet: {
            keyId: creator.id,
            proposalId: proposal.proposalId,
            wallet,
         },
      },
      select: { weight: true },
   });

   const voteWeight = snapshot ? snapshot.weight.toString() : '0';

   const result: KeyPollWeightResponse = {
      key_id: creator.id,
      poll_id: proposal.proposalId,
      wallet,
      vote_weight: voteWeight,
      snapshot_block: proposal.snapshotLedger,
   };

   try {
      await cacheSetJson(cacheKey, result, POLL_WEIGHT_CACHE_TTL_SECONDS);
   } catch (error) {
      logger.warn({ error, keyId, pollId, wallet }, 'Failed to cache key poll weight');
   }

   return result;
}
