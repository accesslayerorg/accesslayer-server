// src/modules/indexer/staking-epoch-indexer.service.ts
// Indexes StakeCreated, EpochRewardDistributed, and RewardsClaimed contract
// events into the stakes and epoch_rewards read models (#1086).
//
// Handler contract:
//   - Each batch is deduped by (txHash, eventIndex) before processing.
//   - Malformed / incomplete events are skipped with a warn log; they do not
//     abort the batch so healthy events in the same delivery still land.
//   - Every write is idempotent: duplicate delivery of the same event is a
//     safe no-op at the DB layer (upsert with empty update: {}).
//   - The highest processed ledger is checkpointed after each batch so the
//     gap detector can flag missed ranges.

import { createHash } from 'crypto';
import { logger } from '../../utils/logger.utils';
import {
   IndexerChainEvent,
   processIndexerChainEvents,
} from '../../utils/indexer-event-processor.utils';
import { dedupeChainEvents } from '../../utils/indexer-dedupe.utils';
import { updateIndexedLedger } from './ledger-gap-detection.service';
import {
   recordStake,
   recordEpochReward,
   removeStake,
} from '../staking/staking-epoch.service';

// ── Event type constants (exported for pipeline registration) ─

export const STAKING_EPOCH_EVENT_TYPES = new Set([
   'STAKE_CREATED',
   'StakeCreated',
   'EPOCH_REWARD_DISTRIBUTED',
   'EpochRewardDistributed',
   'REWARDS_CLAIMED',
   'RewardsClaimed',
]);

// ── Typed event interfaces ────────────────────────────────────

/**
 * Emitted by the staking contract when a wallet stakes tokens.
 *
 * Required fields:
 *   wallet      — staking wallet address
 *   keyId       — creator key the tokens are staked against
 *   amount      — staked token amount (decimal string)
 *   startEpoch  — epoch sequence in which the stake begins
 *   ledger      — ledger sequence of the event
 *   txHash      — transaction hash (dedup key together with eventIndex)
 *   eventIndex  — position within the transaction
 *
 * Optional:
 *   epochsTotal — lock duration in epochs; omit for flexible (unlocked) stakes
 */
export interface StakeCreatedEvent extends IndexerChainEvent {
   eventType: 'STAKE_CREATED' | 'StakeCreated';
   wallet: string;
   keyId: string;
   amount: string;
   startEpoch: number;
   epochsTotal?: number;
}

/**
 * Emitted once per epoch per key when the staking contract distributes rewards.
 *
 * Required fields:
 *   epoch            — the epoch sequence that was distributed
 *   keyId            — creator key the rewards belong to
 *   totalDistributed — total reward tokens distributed (decimal string)
 *   distributedAt    — ISO-8601 timestamp of the distribution
 *   ledger / txHash / eventIndex — chain correlation
 */
export interface EpochRewardDistributedEvent extends IndexerChainEvent {
   eventType: 'EPOCH_REWARD_DISTRIBUTED' | 'EpochRewardDistributed';
   epoch: number;
   keyId: string;
   totalDistributed: string;
   distributedAt: string;
}

/**
 * Emitted when a wallet claims accumulated rewards and optionally closes the
 * staking position.
 *
 * Required fields:
 *   stakeId       — DB id of the Stake row to close (set by the chain indexer
 *                   pipeline, which maps the on-chain position handle to our
 *                   internal id before dispatching the event)
 *   wallet        — claiming wallet
 *   closePosition — true signals the position should be marked removed
 *   claimedAt     — ISO-8601 timestamp of the claim
 *   ledger / txHash / eventIndex — chain correlation
 */
export interface RewardsClaimedEvent extends IndexerChainEvent {
   eventType: 'REWARDS_CLAIMED' | 'RewardsClaimed';
   stakeId: string;
   wallet: string;
   closePosition: boolean;
   claimedAt: string;
}

// ── Required-field validators ─────────────────────────────────

const STAKE_CREATED_REQUIRED: (keyof StakeCreatedEvent & string)[] = [
   'wallet',
   'keyId',
   'amount',
   'startEpoch',
   'ledger',
   'txHash',
   'eventIndex',
];

const EPOCH_REWARD_REQUIRED: (keyof EpochRewardDistributedEvent & string)[] = [
   'epoch',
   'keyId',
   'totalDistributed',
   'distributedAt',
   'ledger',
   'txHash',
   'eventIndex',
];

const REWARDS_CLAIMED_REQUIRED: (keyof RewardsClaimedEvent & string)[] = [
   'stakeId',
   'wallet',
   'claimedAt',
   'ledger',
   'txHash',
   'eventIndex',
];

function missingField(
   event: IndexerChainEvent,
   fields: string[]
): string | null {
   for (const field of fields) {
      const value = (event as Record<string, unknown>)[field];
      if (value === undefined || value === null || value === '') return field;
   }
   return null;
}

// ── Batch processor ───────────────────────────────────────────

/**
 * Processes a mixed batch of staking epoch events, routing each to the
 * appropriate handler. Malformed events are skipped; the ledger cursor is
 * checkpointed after all events are processed.
 */
export async function processStakingEpochEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      const type = event.eventType;

      if (type === 'STAKE_CREATED' || type === 'StakeCreated') {
         await handleStakeCreated(event as StakeCreatedEvent);
         return;
      }

      if (
         type === 'EPOCH_REWARD_DISTRIBUTED' ||
         type === 'EpochRewardDistributed'
      ) {
         await handleEpochRewardDistributed(
            event as EpochRewardDistributedEvent
         );
         return;
      }

      if (type === 'REWARDS_CLAIMED' || type === 'RewardsClaimed') {
         await handleRewardsClaimed(event as RewardsClaimedEvent);
         return;
      }
   });

   await checkpointHighestLedger(events);
}

// ── Individual handlers ───────────────────────────────────────

async function handleStakeCreated(e: StakeCreatedEvent): Promise<void> {
   const missing = missingField(e, STAKE_CREATED_REQUIRED);
   if (missing) {
      logger.warn(
         { eventId: `${e.txHash}:${e.eventIndex}`, missingField: missing },
         'Skipping STAKE_CREATED event due to missing required field'
      );
      return;
   }

   const amount = Number(e.amount);
   if (!Number.isFinite(amount) || amount <= 0) {
      logger.warn(
         { eventId: `${e.txHash}:${e.eventIndex}`, amount: e.amount },
         'Skipping STAKE_CREATED event with invalid amount'
      );
      return;
   }

   const startEpoch = Number(e.startEpoch);
   if (!Number.isInteger(startEpoch) || startEpoch < 0) {
      logger.warn(
         { eventId: `${e.txHash}:${e.eventIndex}`, startEpoch: e.startEpoch },
         'Skipping STAKE_CREATED event with invalid startEpoch'
      );
      return;
   }

   await recordStake({
      wallet: e.wallet,
      keyId: e.keyId,
      amount: e.amount,
      startEpoch,
      epochsTotal: e.epochsTotal != null ? Number(e.epochsTotal) : undefined,
      ledger: Number(e.ledger),
      txHash: String(e.txHash),
      eventIndex: Number(e.eventIndex),
   });

   logger.info(
      {
         wallet: e.wallet,
         keyId: e.keyId,
         amount: e.amount,
         startEpoch,
         ledger: Number(e.ledger),
         txHash: String(e.txHash),
      },
      'STAKE_CREATED event processed'
   );
}

async function handleEpochRewardDistributed(
   e: EpochRewardDistributedEvent
): Promise<void> {
   const missing = missingField(e, EPOCH_REWARD_REQUIRED);
   if (missing) {
      logger.warn(
         { eventId: `${e.txHash}:${e.eventIndex}`, missingField: missing },
         'Skipping EPOCH_REWARD_DISTRIBUTED event due to missing required field'
      );
      return;
   }

   const epoch = Number(e.epoch);
   if (!Number.isInteger(epoch) || epoch < 0) {
      logger.warn(
         { eventId: `${e.txHash}:${e.eventIndex}`, epoch: e.epoch },
         'Skipping EPOCH_REWARD_DISTRIBUTED event with invalid epoch'
      );
      return;
   }

   const totalDistributed = Number(e.totalDistributed);
   if (!Number.isFinite(totalDistributed) || totalDistributed < 0) {
      logger.warn(
         {
            eventId: `${e.txHash}:${e.eventIndex}`,
            totalDistributed: e.totalDistributed,
         },
         'Skipping EPOCH_REWARD_DISTRIBUTED event with invalid totalDistributed'
      );
      return;
   }

   const distributedAt = new Date(e.distributedAt);
   if (Number.isNaN(distributedAt.getTime())) {
      logger.warn(
         {
            eventId: `${e.txHash}:${e.eventIndex}`,
            distributedAt: e.distributedAt,
         },
         'Skipping EPOCH_REWARD_DISTRIBUTED event with invalid distributedAt'
      );
      return;
   }

   await recordEpochReward({
      epoch,
      keyId: e.keyId,
      totalDistributed: e.totalDistributed,
      ledger: Number(e.ledger),
      txHash: String(e.txHash),
      eventIndex: Number(e.eventIndex),
      distributedAt,
   });

   logger.info(
      {
         epoch,
         keyId: e.keyId,
         totalDistributed: e.totalDistributed,
         ledger: Number(e.ledger),
         txHash: String(e.txHash),
      },
      'EPOCH_REWARD_DISTRIBUTED event processed'
   );
}

async function handleRewardsClaimed(e: RewardsClaimedEvent): Promise<void> {
   const missing = missingField(e, REWARDS_CLAIMED_REQUIRED);
   if (missing) {
      logger.warn(
         { eventId: `${e.txHash}:${e.eventIndex}`, missingField: missing },
         'Skipping REWARDS_CLAIMED event due to missing required field'
      );
      return;
   }

   const claimedAt = new Date(e.claimedAt);
   if (Number.isNaN(claimedAt.getTime())) {
      logger.warn(
         { eventId: `${e.txHash}:${e.eventIndex}`, claimedAt: e.claimedAt },
         'Skipping REWARDS_CLAIMED event with invalid claimedAt'
      );
      return;
   }

   // Only close the position when the event explicitly signals it; a plain
   // reward claim without closePosition=true leaves the stake active.
   if (e.closePosition === true) {
      await removeStake(e.stakeId, {
         txHash: String(e.txHash),
         eventIndex: Number(e.eventIndex),
         removedAt: claimedAt,
      });

      logger.info(
         {
            stakeId: e.stakeId,
            wallet: e.wallet,
            ledger: Number(e.ledger),
            txHash: String(e.txHash),
         },
         'REWARDS_CLAIMED (closePosition=true): stake removed'
      );
   } else {
      logger.info(
         {
            stakeId: e.stakeId,
            wallet: e.wallet,
            ledger: Number(e.ledger),
            txHash: String(e.txHash),
         },
         'REWARDS_CLAIMED event processed (position kept open)'
      );
   }
}

// ── Ledger checkpoint ─────────────────────────────────────────

async function checkpointHighestLedger(
   events: IndexerChainEvent[]
): Promise<void> {
   const unique = dedupeChainEvents(events);
   const ledgers = unique
      .map(e => e.ledger)
      .filter((l): l is number => typeof l === 'number');

   if (ledgers.length === 0) return;

   const maxLedger = Math.max(...ledgers);
   const identifiers = unique
      .map(e => `${e.txHash}:${e.eventIndex}`)
      .sort()
      .join('|');
   const batchHash = createHash('sha256')
      .update(identifiers, 'utf8')
      .digest('hex')
      .slice(0, 16);

   await updateIndexedLedger(maxLedger, `${maxLedger}-000`, batchHash);
}
