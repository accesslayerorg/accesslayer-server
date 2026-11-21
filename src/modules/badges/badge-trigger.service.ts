// src/modules/badges/badge-trigger.service.ts
// Badge trigger service (#1148): turns qualifying on-chain events into badge
// awards and routes them through the deduplicating mint service.
//
// `evaluateEvent` is pure — it decides which badges an event earns — so the
// qualification rules are trivially unit-testable. `processQualifyingEvent`
// wires that decision to `mintBadge`. Indexer / webhook consumers call
// `processQualifyingEvent` as qualifying activity is observed.

import { logger } from '../../utils/logger.utils';
import {
   holdMilestoneDays,
   topTraderMaxRank,
   whaleThresholdXlm,
} from './badge.constants';
import { mintBadge, type BadgeMintDeps } from './badge-mint.service';
import type {
   BadgeAward,
   ProcessEventResult,
   QualifyingEvent,
} from './badge.types';

/**
 * Pure qualification check: given a qualifying event, return the badge awards
 * it earns. A single swap can earn both FIRST_BUYER and WHALE_HOLDER.
 */
export function evaluateEvent(event: QualifyingEvent): BadgeAward[] {
   switch (event.kind) {
      case 'swap': {
         const awards: BadgeAward[] = [];
         if (event.isFirstSwap) {
            awards.push({
               wallet: event.wallet,
               badgeType: 'FIRST_BUYER',
               triggerEvent: 'first_swap',
               metadata: { amount: event.amount, txHash: event.txHash },
            });
         }
         if (event.amount >= whaleThresholdXlm()) {
            awards.push({
               wallet: event.wallet,
               badgeType: 'WHALE_HOLDER',
               triggerEvent: 'whale_swap',
               metadata: {
                  amount: event.amount,
                  threshold: whaleThresholdXlm(),
                  txHash: event.txHash,
               },
            });
         }
         return awards;
      }
      case 'vote':
         return [
            {
               wallet: event.wallet,
               badgeType: 'GOVERNANCE_VOTER',
               triggerEvent: 'vote_cast',
               metadata: { proposalId: event.proposalId, txHash: event.txHash },
            },
         ];
      case 'hold':
         if (event.holdDurationDays >= holdMilestoneDays()) {
            return [
               {
                  wallet: event.wallet,
                  badgeType: 'DIAMOND_HANDS',
                  triggerEvent: 'hold_milestone',
                  metadata: {
                     holdDurationDays: event.holdDurationDays,
                     milestoneDays: holdMilestoneDays(),
                     txHash: event.txHash,
                  },
               },
            ];
         }
         return [];
      case 'leaderboard':
         if (event.rank >= 1 && event.rank <= topTraderMaxRank()) {
            return [
               {
                  wallet: event.wallet,
                  badgeType: 'TOP_TRADER',
                  triggerEvent: 'leaderboard_entry',
                  metadata: {
                     rank: event.rank,
                     maxRank: topTraderMaxRank(),
                     txHash: event.txHash,
                  },
               },
            ];
         }
         return [];
      default: {
         // Exhaustiveness guard: a new event kind must be handled above.
         const _never: never = event;
         return _never;
      }
   }
}

/**
 * Process a qualifying on-chain event: evaluate the badges it earns and mint
 * each one (deduplicated). Minting one badge never blocks the others.
 */
export async function processQualifyingEvent(
   event: QualifyingEvent,
   deps?: BadgeMintDeps
): Promise<ProcessEventResult> {
   const awards = evaluateEvent(event);

   if (awards.length === 0) {
      logger.debug(
         { kind: event.kind, wallet: event.wallet },
         'Qualifying event earned no badges'
      );
      return { awards: [] };
   }

   const results = await Promise.all(
      awards.map(award =>
         mintBadge(
            award.wallet,
            award.badgeType,
            award.triggerEvent,
            deps,
            award.metadata
         )
      )
   );

   return { awards: results };
}
