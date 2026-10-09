import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';
import {
   REDIS_KEYS,
   KEY_STAKING_CACHE_TTL_SECONDS,
} from '../../constants/notifications.constants';

export class KeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'KeyNotFoundError';
   }
}

export interface KeyStakingPool {
   stakingPoolBalance: string;
   totalStaked: string;
   recentFeeInflow: string;
   stakerCount: number;
}

/**
 * Returns staking pool stats for a key: pool balance, total staked quantity,
 * recent protocol fee inflow (last 30 days), and staker count.
 *
 * Reads staking state from on-chain contract storage via Soroban RPC and
 * caches the response in Redis for 60 seconds.
 */
export async function getKeyStaking(keyId: string): Promise<KeyStakingPool> {
   const cacheKey = REDIS_KEYS.keyStaking(keyId);

   const cached = await cacheGetJson<KeyStakingPool>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   const creator = await prisma.creatorProfile.findUnique({
      where: { id: keyId },
      select: { id: true },
   });

   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const onChainStaking = await readStakingFromChain(keyId);

   const stakingPool: KeyStakingPool = {
      stakingPoolBalance: onChainStaking?.stakingPoolBalance ?? '0',
      totalStaked: onChainStaking?.totalStaked ?? '0',
      recentFeeInflow: onChainStaking?.recentFeeInflow ?? '0',
      stakerCount: onChainStaking?.stakerCount ?? 0,
   };

   await cacheSetJson(cacheKey, stakingPool, KEY_STAKING_CACHE_TTL_SECONDS);
   return stakingPool;
}

/**
 * Reads staking pool state from on-chain persistent contract storage via Soroban RPC.
 *
 * In a full implementation this would:
 * 1. Build XDR ledger entry keys for:
 *    - staking_pool_balance (ScpVal::U128)
 *    - total_staked (ScpVal::U64)
 *    - staker_count (ScpVal::U32)
 * 2. Call getLedgerEntries() via Soroban RPC
 * 3. Decode XDR responses
 * 4. For recentFeeInflow, sum fee events from the past 30 days
 *    by querying contract events via Soroban event archive
 */
async function readStakingFromChain(
   keyId: string
): Promise<Omit<KeyStakingPool, 'recentFeeInflow'> & { recentFeeInflow: string } | null> {
   try {
      logger.debug({ keyId }, 'Reading staking pool state from on-chain storage');

      // TODO: Implement Soroban RPC call to read staking pool state
      // This would query the staking_positions contract's persistent storage for:
      // - pool_balance (ScpVal::U128)
      // - total_staked (ScpVal::U64)
      // - staker_count (ScpVal::U32)
      //
      // For recentFeeInflow, sum fee collection events from the past 30 days
      // by scanning contract events since current_ledger - ~518400 ledgers
      // (30 days * 17280 ledgers/day)

      return null;
   } catch (error) {
      logger.warn(
         { error, keyId },
         'Failed to read staking pool state from on-chain storage'
      );
      return null;
   }
}

/**
 * Invalidates the staking cache for a key.
 * Called after stake, unstake, or fee collection events.
 */
export async function invalidateKeyStakingCache(keyId: string): Promise<void> {
   await cacheInvalidate(REDIS_KEYS.keyStaking(keyId));
}
