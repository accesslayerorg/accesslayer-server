// src/modules/indexer/referral-tier-indexer.service.ts
// Indexes on-chain `ReferralTierUpgraded` events into the referral tier read
// models (#1034).
//
// Each upgrade is written by `recordReferralTierUpgrade`, whose
// `(txHash, eventIndex)` unique constraint makes replays idempotent and whose
// state update only ever advances a wallet's tier. The highest processed
// ledger is checkpointed so gaps can be detected.

import { createHash } from 'crypto';
import { logger } from '../../utils/logger.utils';
import {
   IndexerChainEvent,
   processIndexerChainEvents,
} from '../../utils/indexer-event-processor.utils';
import { dedupeChainEvents } from '../../utils/indexer-dedupe.utils';
import { updateIndexedLedger } from './ledger-gap-detection.service';
import { recordReferralTierUpgrade } from '../referrals/referral-tier.service';
import { isValidReferralTier } from '../referrals/referral-tier.constants';

/**
 * Chain event for the `referral_tier_upgraded` contract event (#1034).
 */
export interface ReferralTierUpgradedEvent extends IndexerChainEvent {
   eventType: 'REFERRAL_TIER_UPGRADED';
   /** Referrer wallet whose tier changed. */
   walletAddress: string;
   /** Tier before the upgrade (0 for a wallet's first tier). */
   previousTier: number;
   /** Tier after the upgrade (1, 2 or 3). */
   newTier: number;
   /** Cumulative referred volume in XLM, as a string for precision. */
   cumulativeVolume: string;
   /** On-chain event timestamp (ISO string). */
   upgradedAt: string;
}

/**
 * Processes a batch of `REFERRAL_TIER_UPGRADED` events, recording one history
 * row and advancing the wallet's tier state per upgrade. Malformed events are
 * skipped with a warn log; duplicates are deduped within the batch and by the
 * DB unique key.
 */
export async function processReferralTierUpgradedEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (event.eventType !== 'REFERRAL_TIER_UPGRADED') {
         return;
      }

      const typedEvent = event as ReferralTierUpgradedEvent;
      const requiredFields = [
         'walletAddress',
         'previousTier',
         'newTier',
         'cumulativeVolume',
         'upgradedAt',
         'ledger',
      ];
      for (const field of requiredFields) {
         const value = typedEvent[field as keyof ReferralTierUpgradedEvent];
         if (value === undefined || value === null || value === '') {
            logger.warn(
               {
                  eventId: `${event.txHash}:${event.eventIndex}`,
                  missingField: field,
               },
               'Skipping referral tier event due to missing required field'
            );
            return;
         }
      }

      const previousTier = Number(typedEvent.previousTier);
      const newTier = Number(typedEvent.newTier);
      if (
         !Number.isInteger(previousTier) ||
         previousTier < 0 ||
         !isValidReferralTier(newTier) ||
         newTier <= previousTier
      ) {
         logger.warn(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
               previousTier: typedEvent.previousTier,
               newTier: typedEvent.newTier,
            },
            'Skipping referral tier event with invalid tier transition'
         );
         return;
      }

      const cumulativeVolume = Number(typedEvent.cumulativeVolume);
      if (!Number.isFinite(cumulativeVolume) || cumulativeVolume < 0) {
         logger.warn(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
               cumulativeVolume: typedEvent.cumulativeVolume,
            },
            'Skipping referral tier event with invalid cumulative volume'
         );
         return;
      }

      const occurredAt = new Date(typedEvent.upgradedAt);
      if (Number.isNaN(occurredAt.getTime())) {
         logger.warn(
            {
               eventId: `${event.txHash}:${event.eventIndex}`,
               upgradedAt: typedEvent.upgradedAt,
            },
            'Skipping referral tier event with invalid timestamp'
         );
         return;
      }

      await recordReferralTierUpgrade({
         walletAddress: typedEvent.walletAddress,
         previousTier,
         newTier,
         cumulativeVolume,
         txHash: String(typedEvent.txHash),
         eventIndex: Number(typedEvent.eventIndex),
         ledger: Number(typedEvent.ledger),
         occurredAt,
      });

      logger.info(
         {
            walletAddress: typedEvent.walletAddress,
            previousTier,
            newTier,
            cumulativeVolume: typedEvent.cumulativeVolume,
            ledger: Number(typedEvent.ledger),
            txHash: String(typedEvent.txHash),
         },
         'Referral tier upgrade recorded'
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
