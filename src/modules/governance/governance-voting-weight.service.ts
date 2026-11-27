import { Decimal } from '@prisma/client/runtime/library';
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';
import { resolveCreatorId } from '../whitelist/whitelist.service';

export const VOTING_WEIGHT_CACHE_TTL_SECONDS = 60;
// Indexed balances can exceed Decimal's default 20 significant digits.
const WeightDecimal = Decimal.clone({ precision: 100 });

export interface WalletVotingWeight {
   own_weight: string;
   delegated_weight: string;
   total: string;
   delegators: Array<{ wallet: string; amount: string }>;
}

export function votingWeightCacheKey(keyId: string, wallet: string): string {
   return `governance:voting-weight:${encodeURIComponent(keyId)}:${wallet}`;
}

/** A balance or delegation change can affect any delegatee on this key. */
export async function invalidateKeyVotingWeightCache(keyId: string): Promise<void> {
   await cacheInvalidate(votingWeightCacheKey(keyId, '*'));
}

/** Current balances, rather than the frozen snapshot used by proposal votes. */
export async function getWalletVotingWeight(
   wallet: string,
   keyId: string
): Promise<WalletVotingWeight> {
   const canonicalKeyId = (await resolveCreatorId(keyId)) ?? keyId;
   const cacheKey = votingWeightCacheKey(canonicalKeyId, wallet);
   const cached = await cacheGetJson<WalletVotingWeight>(cacheKey);
   if (cached !== null) return cached;

   const result = await prisma.$transaction(async tx => {
      const active = await tx.voteDelegation.findMany({
         where: {
            keyId: canonicalKeyId, delegateeWallet: wallet, isActive: true,
            delegatorWallet: { not: wallet },
         },
         select: { delegatorWallet: true },
         orderBy: { delegatorWallet: 'asc' },
      });
      const addresses = [...new Set(
         active.map(row => row.delegatorWallet).filter(address => address !== wallet)
      )].sort();
      const holdings = await tx.keyOwnership.findMany({
         where: { creatorId: canonicalKeyId, ownerAddress: { in: [wallet, ...addresses] }, balance: { gt: 0 } },
         select: { ownerAddress: true, balance: true },
      });
      const balances = new Map(holdings.map(row => [row.ownerAddress, row.balance]));
      const own = new WeightDecimal(balances.get(wallet) ?? 0);
      const delegators = addresses.map(address => ({
         wallet: address, amount: new WeightDecimal(balances.get(address) ?? 0).toFixed(),
      }));
      const delegated = delegators.reduce(
         (total, row) => total.plus(row.amount), new WeightDecimal(0)
      );
      return {
         own_weight: own.toFixed(), delegated_weight: delegated.toFixed(),
         total: own.plus(delegated).toFixed(), delegators,
      };
   }, { isolationLevel: 'RepeatableRead' });

   await cacheSetJson(cacheKey, result, VOTING_WEIGHT_CACHE_TTL_SECONDS);
   return result;
}
