// src/modules/staking/staking.service.ts
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { StakeInput, UnstakeInput, VALID_LOCK_PERIODS } from './staking.schemas';

export class KeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'KeyNotFoundError';
   }
}

export class InsufficientBalanceError extends Error {
   constructor(wallet: string, keyId: string) {
      super(`Insufficient balance for wallet ${wallet} on key ${keyId}`);
      this.name = 'InsufficientBalanceError';
   }
}

export class LockPeriodNotExpiredError extends Error {
   constructor(lockedUntil: Date) {
      super(`Lock period has not expired. Unlocks at ${lockedUntil.toISOString()}`);
      this.name = 'LockPeriodNotExpiredError';
   }
}

export class InvalidLockPeriodError extends Error {
   constructor() {
      super(`Invalid lock period. Valid options: ${VALID_LOCK_PERIODS.join(', ')}`);
      this.name = 'InvalidLockPeriodError';
   }
}

export interface StakeResult {
   id: string;
   keyId: string;
   wallet: string;
   amount: string;
   lockPeriodDays: number;
   lockedUntil: Date;
}

export interface UnstakeResult {
   id: string;
   keyId: string;
   wallet: string;
   amount: string;
   unstakedAt: Date;
}

export async function createStake(
   wallet: string,
   input: StakeInput
): Promise<StakeResult> {
   const { keyId, amount, lockPeriodDays } = input;

   const creator = await prisma.creatorProfile.findUnique({
      where: { id: keyId },
      select: { id: true },
   });

   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const ownership = await prisma.keyOwnership.findUnique({
      where: {
         ownerAddress_creatorId: { ownerAddress: wallet, creatorId: keyId },
      },
   });

   const balance = ownership ? BigInt(ownership.balance.toString()) : 0n;
   if (balance < BigInt(amount)) {
      throw new InsufficientBalanceError(wallet, keyId);
   }

   const lockedUntil = new Date(
      Date.now() + lockPeriodDays * 24 * 60 * 60 * 1000
   );

   const position = await prisma.$transaction(async (tx) => {
      // Check if position exists
      const existing = await tx.stakingPosition.findUnique({
         where: { keyId_wallet: { keyId, wallet } },
      });

      let result;
      if (existing) {
         // Update existing position
         const newAmount = BigInt(existing.amount.toString()) + BigInt(amount);
         result = await tx.stakingPosition.update({
            where: { id: existing.id },
            data: {
               amount: newAmount.toString(),
               lockPeriodDays,
               lockedUntil,
            },
         });
      } else {
         // Create new position
         result = await tx.stakingPosition.create({
            data: {
               keyId,
               wallet,
               amount: amount.toString(),
               lockPeriodDays,
               lockedUntil,
            },
         });
      }

      // Emit staking event
      await tx.activity.create({
         data: {
            type: 'STAKE_CREATED',
            actor: wallet,
            creatorId: keyId,
            payload: {
               keyId,
               amount,
               lockPeriodDays,
               lockedUntil: lockedUntil.toISOString(),
            },
         },
      });

      return result;
   });

   logger.info(
      { wallet, keyId, amount, lockPeriodDays, lockedUntil },
      'Stake created'
   );

   return {
      id: position.id,
      keyId: position.keyId,
      wallet: position.wallet,
      amount: position.amount.toString(),
      lockPeriodDays: position.lockPeriodDays,
      lockedUntil: position.lockedUntil,
   };
}

export async function unstake(
   wallet: string,
   input: UnstakeInput
): Promise<UnstakeResult> {
   const { keyId, amount } = input;

   const position = await prisma.stakingPosition.findUnique({
      where: { keyId_wallet: { keyId, wallet } },
   });

   if (!position) {
      throw new Error('No staking position found for this wallet and key');
   }

   if (position.lockedUntil > new Date()) {
      throw new LockPeriodNotExpiredError(position.lockedUntil);
   }

   const currentAmount = BigInt(position.amount.toString());
   if (currentAmount < BigInt(amount)) {
      throw new InsufficientBalanceError(wallet, keyId);
   }

   const unstakedAt = new Date();

   const result = await prisma.$transaction(async (tx) => {
      let updated;
      if (currentAmount === BigInt(amount)) {
         // Fully unstake
         updated = await tx.stakingPosition.update({
            where: { id: position.id },
            data: {
               amount: '0',
               unstakedAt,
            },
         });
      } else {
         // Partial unstake
         updated = await tx.stakingPosition.update({
            where: { id: position.id },
            data: {
               amount: (currentAmount - BigInt(amount)).toString(),
            },
         });
      }

      // Emit unstaking event
      await tx.activity.create({
         data: {
            type: 'STAKE_UNSTAKED',
            actor: wallet,
            creatorId: keyId,
            payload: {
               keyId,
               amount,
               unstakedAt: unstakedAt.toISOString(),
            },
         },
      });

      return updated;
   });

   logger.info({ wallet, keyId, amount, unstakedAt }, 'Unstake completed');

   return {
      id: result.id,
      keyId: result.keyId,
      wallet: result.wallet,
      amount: amount.toString(),
      unstakedAt,
   };
}

export async function getStakingPositions(
   wallet: string
): Promise<
   Array<{
      id: string;
      keyId: string;
      amount: string;
      lockPeriodDays: number;
      lockedUntil: Date;
      unstakedAt: Date | null;
   }>
> {
   const positions = await prisma.stakingPosition.findMany({
      where: { wallet, amount: { not: '0' } },
      orderBy: { lockedUntil: 'asc' },
   });

   return positions.map((p: any) => ({
      id: p.id,
      keyId: p.keyId,
      amount: p.amount.toString(),
      lockPeriodDays: p.lockPeriodDays,
      lockedUntil: p.lockedUntil,
      unstakedAt: p.unstakedAt,
   }));
}
