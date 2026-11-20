// src/modules/indexer/referral-earnings-indexer.service.ts
// Indexes on-chain `ReferralRewardDistributed` events into the
// `referral_earnings` read model (#1057).
//
// Each reward is written by `recordReferralEarning`, whose `(txHash,
// eventIndex)` unique constraint makes replays idempotent, and which
// invalidates the affected wallet's cached earnings. The highest processed
// ledger is checkpointed so gaps can be detected.

import { createHash } from 'crypto';
import { logger } from '../../utils/logger.utils';
import {
   IndexerChainEvent,
   processIndexerChainEvents,
} from '../../utils/indexer-event-processor.utils';
import { dedupeChainEvents } from '../../utils/indexer-dedupe.utils';
import { updateIndexedLedger } from './ledger-gap-detection.service';
import { recordReferralEarning } from '../referrals/referral-earnings.service';

/**
 * Chain event for the `referral_reward_distributed` contract event (#1057).
 */
export interface ReferralRewardDistributedEvent extends IndexerChainEvent {
   eventType: 'REFERRAL_REWARD_DISTRIBUTED';
   /** Wallet that earned the reward. */
   referrerWallet: string;
   /** Referred wallet whose activity generated the reward. */
   sourceWallet: string;
   /** Referral tier (1, 2 or 3). */
   tier: number;
   /** Reward amount in XLM, as a string for precision. */
   amount: string;
   /** On-chain event timestamp (ISO string). */
   distributedAt: string;
   /** Optional contract-level reward id. */
   rewardId?: string;
}

const VALID_TIERS = new Set([1, 2, 3]);

/**
 * Processes a batch of `REFERRAL_REWARD_DISTRIBUTED` events, persisting one
 * `ReferralEarning` row per reward. Malformed events are skipped with a warn
 * log; duplicates are deduped within the batch and by the DB unique key.
 */
export async function processReferralRewardDistributedEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (event.eventType !== 'REFERRAL_REWARD_DISTRIBUTED') {
         return;
      }

      const typedEvent = event as ReferralRewardDistributedEvent;
      const requiredFields = [
         'referrerWallet',
         'sourceWallet',
         'tier',
         'amount',
         'distributedAt',
         'ledger',
      ];
      for (const field of requiredFields) {
         const value = typedEvent[field as keyof ReferralRewardDistributedEvent];
         if (value === undefined || value === null || value === '') {
            logger.warn(
               {
                  eventId: `${event.txHash}:${event.eventIndex}`,
                  missingField: field,
               },
               'Skipping referral reward event due to missing required field'
            );
            return;
         }
      }

      const tier = Number(typedEvent.tier);
      if (!VALID_TIERS.has(tier)) {
         logger.warn(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
               tier: typedEvent.tier,
            },
            'Skipping referral reward event with invalid tier'
         );
         return;
      }

      const amount = Number(typedEvent.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
         logger.warn(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
               amount: typedEvent.amount,
            },
            'Skipping referral reward event with invalid amount'
         );
         return;
      }

      const earnedAt = new Date(typedEvent.distributedAt);
      if (Number.isNaN(earnedAt.getTime())) {
         logger.warn(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
               distributedAt: typedEvent.distributedAt,
            },
            'Skipping referral reward event with invalid timestamp'
         );
         return;
      }

      await recordReferralEarning({
         referrerWallet: typedEvent.referrerWallet,
         sourceWallet: typedEvent.sourceWallet,
         tier,
         amount,
         txHash: String(typedEvent.txHash),
         eventIndex: Number(typedEvent.eventIndex),
         ledger: Number(typedEvent.ledger),
         earnedAt,
      });

      logger.info(
         {
            referrerWallet: typedEvent.referrerWallet,
            sourceWallet: typedEvent.sourceWallet,
            tier,
            amount: typedEvent.amount,
            ledger: Number(typedEvent.ledger),
            txHash: String(typedEvent.txHash),
         },
         'Referral reward recorded'
      );
   });

   await checkpointHighestLedger(events);
}

async function checkpointHighestLedger(
   events: IndexerChainEvent[]
): Promise<void> {
   const uniqueEvents = dedupeChainEvents(events);
   const processedLedgers = uniqueEvents
      .map(e => e.ledger)
      .filter((ledger): ledger is number => typeof ledger === 'number');

   if (processedLedgers.length === 0) {
      return;
   }

   const maxLedger = Math.max(...processedLedgers);
   const identifiers = uniqueEvents
      .map(e => `${e.txHash}:${e.eventIndex}`)
      .sort()
      .join('|');
   const batchHash = createHash('sha256')
      .update(identifiers, 'utf8')
      .digest('hex')
      .slice(0, 16);

   await updateIndexedLedger(maxLedger, `${maxLedger}-000`, batchHash);
}
