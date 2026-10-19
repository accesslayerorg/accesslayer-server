import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';

export class StakeNotFoundError extends Error {
   constructor(stakeId: string) {
      super(`Stake position not found: ${stakeId}`);
      this.name = 'StakeNotFoundError';
   }
}

export interface ActiveStakeItem {
   stake_id: string;
   key_id: string;
   amount: string;
   epochs_remaining: number;
   accrued_rewards: string;
   status: string;
}

export interface EpochRewardItem {
   epoch: number;
   key_id: string;
   total_distributed: string;
   reward_per_token: string;
   distributed_at: string;
   tx_hash: string | null;
}

export interface StakeDetailItem {
   stake_id: string;
   wallet: string;
   key_id: string;
   amount: string;
   start_epoch: number;
   lock_epochs: number;
   epochs_remaining: number;
   accrued_rewards: string;
   total_claimed: string;
   status: string;
   epoch_breakdown: EpochRewardItem[];
}

/**
 * Calculates current epoch based on current timestamp or configured epoch duration.
 */
export async function getCurrentEpoch(): Promise<number> {
   const latest = await (prisma as any).epochReward.findFirst({
      orderBy: { epoch: 'desc' },
      select: { epoch: true },
   });
   return latest ? latest.epoch : 1;
}

/**
 * Fetches live accrued rewards for a stake position (#1086).
 * Computes accumulated rewards from epoch_rewards since start_epoch, minus claimed rewards.
 */
export async function getLiveAccruedRewards(
   keyId: string,
   stakedAmount: number,
   startEpoch: number,
   totalClaimed: number
): Promise<string> {
   try {
      const epochRewards = await (prisma as any).epochReward.findMany({
         where: {
            keyId,
            epoch: { gte: startEpoch },
         },
      });

      let accrued = 0;
      for (const er of epochRewards) {
         const rpt = Number(er.rewardPerToken || 0);
         accrued += stakedAmount * rpt;
      }

      const netAccrued = Math.max(0, accrued - totalClaimed);
      return netAccrued.toFixed(7);
   } catch (error) {
      logger.warn({ error, keyId }, 'Error calculating live accrued rewards');
      return '0.0000000';
   }
}

/**
 * GET /staking/:wallet/positions (#1086)
 * Returns active stakes for wallet with key, amount, epochs remaining, accrued rewards.
 */
export async function getWalletActiveStakes(
   wallet: string
): Promise<ActiveStakeItem[]> {
   const stakes = await (prisma as any).stake.findMany({
      where: {
         wallet,
         status: 'active',
         unstakedAt: null,
      },
      orderBy: { createdAt: 'desc' },
   });

   const currentEpoch = await getCurrentEpoch();

   const results: ActiveStakeItem[] = [];
   for (const s of stakes) {
      const amountNum = Number(s.amount);
      const claimedNum = Number(s.totalClaimed || 0);
      const epochsRemaining = Math.max(
         0,
         s.startEpoch + s.lockEpochs - currentEpoch
      );
      const accrued = await getLiveAccruedRewards(
         s.keyId,
         amountNum,
         s.startEpoch,
         claimedNum
      );

      results.push({
         stake_id: s.stakeId,
         key_id: s.keyId,
         amount: String(s.amount),
         epochs_remaining: epochsRemaining,
         accrued_rewards: accrued,
         status: s.status,
      });
   }

   return results;
}

/**
 * GET /staking/:wallet/positions/:stake_id (#1086)
 * Returns single stake detail with epoch breakdown.
 */
export async function getStakeDetail(
   wallet: string,
   stakeId: string
): Promise<StakeDetailItem> {
   const stake = await (prisma as any).stake.findFirst({
      where: {
         wallet,
         stakeId,
      },
   });

   if (!stake) {
      throw new StakeNotFoundError(stakeId);
   }

   const currentEpoch = await getCurrentEpoch();
   const amountNum = Number(stake.amount);
   const claimedNum = Number(stake.totalClaimed || 0);
   const epochsRemaining = Math.max(
      0,
      stake.startEpoch + stake.lockEpochs - currentEpoch
   );
   const accrued = await getLiveAccruedRewards(
      stake.keyId,
      amountNum,
      stake.startEpoch,
      claimedNum
   );

   const epochRewards = await (prisma as any).epochReward.findMany({
      where: {
         keyId: stake.keyId,
         epoch: { gte: stake.startEpoch },
      },
      orderBy: { epoch: 'asc' },
   });

   const epochBreakdown: EpochRewardItem[] = epochRewards.map((er: any) => ({
      epoch: er.epoch,
      key_id: er.keyId,
      total_distributed: String(er.totalDistributed),
      reward_per_token: String(er.rewardPerToken),
      distributed_at: er.distributedAt ? new Date(er.distributedAt).toISOString() : new Date().toISOString(),
      tx_hash: er.txHash ?? null,
   }));

   return {
      stake_id: stake.stakeId,
      wallet: stake.wallet,
      key_id: stake.keyId,
      amount: String(stake.amount),
      start_epoch: stake.startEpoch,
      lock_epochs: stake.lockEpochs,
      epochs_remaining: epochsRemaining,
      accrued_rewards: accrued,
      total_claimed: String(stake.totalClaimed),
      status: stake.status,
      epoch_breakdown: epochBreakdown,
   };
}

/**
 * GET /keys/:key_id/epochs (#1086)
 * Returns epoch reward history with total distributed per epoch.
 */
export async function getKeyEpochHistory(
   keyId: string
): Promise<EpochRewardItem[]> {
   const epochRewards = await (prisma as any).epochReward.findMany({
      where: { keyId },
      orderBy: { epoch: 'desc' },
   });

   return epochRewards.map((er: any) => ({
      epoch: er.epoch,
      key_id: er.keyId,
      total_distributed: String(er.totalDistributed),
      reward_per_token: String(er.rewardPerToken),
      distributed_at: er.distributedAt ? new Date(er.distributedAt).toISOString() : new Date().toISOString(),
      tx_hash: er.txHash ?? null,
   }));
}
