// src/modules/staking/staking-position.service.ts
// Stake / unstake position management with lock period validation (#881).

import { EventEmitter } from 'events';
import { envConfig } from '../../config';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   calculateEffectiveWeight,
   getMultiplierTiers,
   matchTierForLockPeriod,
   StakingPositionNotFoundError,
} from './staking.service';

/** Emits staking events for downstream reward calculation. */
export const stakingEventEmitter = new EventEmitter();

export const STAKING_EVENTS = {
   STAKED: 'staking_staked',
   UNSTAKED: 'staking_unstaked',
} as const;

export interface StakingEventPayload {
   positionId: string;
   wallet: string;
   keyId: string | null;
   amount: string;
   lockPeriodSeconds: number;
   tier: number;
   effectiveWeight: string;
   lockedAt: string;
   unlocksAt: string | null;
   occurredAt: string;
}

export class InvalidLockPeriodError extends Error {
   readonly validOptions: string[];
   constructor(provided: string, validOptions: string[]) {
      super(`Invalid lock period: ${provided}`);
      this.name = 'InvalidLockPeriodError';
      this.validOptions = validOptions;
   }
}

export class StakingKeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'StakingKeyNotFoundError';
   }
}

export class LockPeriodNotExpiredError extends Error {
   readonly unlocksAt: Date;
   constructor(unlocksAt: Date) {
      super('Lock period has not expired');
      this.name = 'LockPeriodNotExpiredError';
      this.unlocksAt = unlocksAt;
   }
}

export class PositionAlreadyUnstakedError extends Error {
   constructor(positionId: string) {
      super(`Position already unstaked: ${positionId}`);
      this.name = 'PositionAlreadyUnstakedError';
   }
}

/**
 * Parse `name=seconds` pairs (comma separated), e.g. "flexible=0,30d=2592000".
 * Malformed entries are skipped.
 */
export function parseLockPeriodOptions(raw: string): Record<string, number> {
   const options: Record<string, number> = {};
   for (const entry of raw.split(',')) {
      const [name, seconds] = entry.split('=').map(part => part.trim());
      const value = Number(seconds);
      if (
         name &&
         seconds !== undefined &&
         Number.isInteger(value) &&
         value >= 0
      ) {
         options[name] = value;
      }
   }
   return options;
}

/** Lock period options (name -> seconds) configured via the environment. */
export function getLockPeriodOptions(): Record<string, number> {
   return parseLockPeriodOptions(envConfig.STAKING_LOCK_PERIOD_OPTIONS);
}

function emitStakingEvent(
   event: (typeof STAKING_EVENTS)[keyof typeof STAKING_EVENTS],
   payload: StakingEventPayload
): void {
   try {
      stakingEventEmitter.emit(event, payload);
   } catch (error) {
      // A failing listener must never fail the request.
      logger.error({ error, event }, 'Staking event listener failed');
   }
}

export interface StakeInput {
   wallet: string;
   keyId: string;
   amount: string;
   lockPeriod: string;
}

export interface StakeResult {
   id: string;
   wallet: string;
   keyId: string | null;
   amount: string;
   lockPeriod: string;
   lockPeriodSeconds: number;
   lockedAt: string;
   unlocksAt: string;
   tier: number;
   effectiveWeight: string;
}

/** Create a staking position with the lock expiry for the chosen option. */
export async function stakeKeys(
   input: StakeInput,
   now: Date = new Date()
): Promise<StakeResult> {
   const options = getLockPeriodOptions();
   if (!Object.prototype.hasOwnProperty.call(options, input.lockPeriod)) {
      throw new InvalidLockPeriodError(input.lockPeriod, Object.keys(options));
   }
   const lockPeriodSeconds = options[input.lockPeriod];

   const creator = await prisma.creatorProfile.findUnique({
      where: { id: input.keyId },
      select: { id: true },
   });
   if (!creator) {
      throw new StakingKeyNotFoundError(input.keyId);
   }

   const tiers = await getMultiplierTiers();
   const tier = matchTierForLockPeriod(lockPeriodSeconds, tiers);
   const unlocksAt = new Date(now.getTime() + lockPeriodSeconds * 1000);

   const position = await prisma.stakingPosition.create({
      data: {
         wallet: input.wallet,
         keyId: input.keyId,
         amount: input.amount,
         lockPeriodSeconds,
         lockedAt: now,
         unlocksAt,
         tier: tier.tier,
      },
   });

   const effectiveWeight = calculateEffectiveWeight(
      input.amount,
      tier.multiplier
   );

   emitStakingEvent(STAKING_EVENTS.STAKED, {
      positionId: position.id,
      wallet: input.wallet,
      keyId: input.keyId,
      amount: input.amount,
      lockPeriodSeconds,
      tier: tier.tier,
      effectiveWeight,
      lockedAt: now.toISOString(),
      unlocksAt: unlocksAt.toISOString(),
      occurredAt: now.toISOString(),
   });

   return {
      id: position.id,
      wallet: input.wallet,
      keyId: input.keyId,
      amount: input.amount,
      lockPeriod: input.lockPeriod,
      lockPeriodSeconds,
      lockedAt: now.toISOString(),
      unlocksAt: unlocksAt.toISOString(),
      tier: tier.tier,
      effectiveWeight,
   };
}

export interface UnstakeInput {
   wallet: string;
   positionId: string;
}

export interface UnstakeResult {
   id: string;
   wallet: string;
   keyId: string | null;
   amount: string;
   unstakedAt: string;
}

/** Unstake a position once its lock period has expired. */
export async function unstakePosition(
   input: UnstakeInput,
   now: Date = new Date()
): Promise<UnstakeResult> {
   const position = await prisma.stakingPosition.findUnique({
      where: { id: input.positionId },
   });

   // Positions of other wallets are reported as not found.
   if (!position || position.wallet !== input.wallet) {
      throw new StakingPositionNotFoundError(input.positionId);
   }
   if (position.unstakedAt) {
      throw new PositionAlreadyUnstakedError(position.id);
   }

   const unlocksAt = position.unlocksAt ?? position.lockedAt;
   if (unlocksAt.getTime() > now.getTime()) {
      throw new LockPeriodNotExpiredError(unlocksAt);
   }

   // Guard against a concurrent unstake of the same position.
   const updated = await prisma.stakingPosition.updateMany({
      where: { id: position.id, unstakedAt: null },
      data: { unstakedAt: now },
   });
   if (updated.count === 0) {
      throw new PositionAlreadyUnstakedError(position.id);
   }

   const tiers = await getMultiplierTiers();
   const tier =
      tiers.find(t => t.tier === position.tier) ??
      matchTierForLockPeriod(position.lockPeriodSeconds, tiers);
   const amount = position.amount.toString();

   emitStakingEvent(STAKING_EVENTS.UNSTAKED, {
      positionId: position.id,
      wallet: position.wallet,
      keyId: position.keyId,
      amount,
      lockPeriodSeconds: position.lockPeriodSeconds,
      tier: tier.tier,
      effectiveWeight: calculateEffectiveWeight(amount, tier.multiplier),
      lockedAt: position.lockedAt.toISOString(),
      unlocksAt: position.unlocksAt ? position.unlocksAt.toISOString() : null,
      occurredAt: now.toISOString(),
   });

   return {
      id: position.id,
      wallet: position.wallet,
      keyId: position.keyId,
      amount,
      unstakedAt: now.toISOString(),
   };
}
