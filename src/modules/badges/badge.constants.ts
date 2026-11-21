// src/modules/badges/badge.constants.ts
// Thresholds and defaults for the badge minting trigger service (#1148).

import { envConfig } from '../../config';
import type { BadgeType, BadgeTriggerEvent } from './badge.types';

/**
 * Minimum single-swap size (in XLM) that qualifies a wallet for the
 * WHALE_HOLDER badge. Overridable via BADGE_WHALE_THRESHOLD_XLM.
 */
export function whaleThresholdXlm(): number {
   return envConfig.BADGE_WHALE_THRESHOLD_XLM;
}

/**
 * Continuous hold duration (in days) that qualifies a wallet for the
 * DIAMOND_HANDS long-term hold badge. Overridable via BADGE_HOLD_MILESTONE_DAYS.
 */
export function holdMilestoneDays(): number {
   return envConfig.BADGE_HOLD_MILESTONE_DAYS;
}

/**
 * Highest leaderboard rank (inclusive, 1-based) that qualifies a wallet for
 * the TOP_TRADER badge. Overridable via BADGE_TOP_TRADER_MAX_RANK.
 */
export function topTraderMaxRank(): number {
   return envConfig.BADGE_TOP_TRADER_MAX_RANK;
}

/** Maximum mint attempts for a single badge before giving up (transient). */
export function mintMaxAttempts(): number {
   return envConfig.BADGE_MINT_MAX_ATTEMPTS;
}

/** Human-readable description per badge type (for logs / future API). */
export const BADGE_DESCRIPTIONS: Record<BadgeType, string> = {
   FIRST_BUYER: 'Awarded on a wallet’s first key purchase',
   WHALE_HOLDER: 'Awarded for a swap above the whale threshold',
   GOVERNANCE_VOTER: 'Awarded for casting a governance vote',
   DIAMOND_HANDS: 'Awarded for a 365-day continuous hold',
   TOP_TRADER: 'Awarded for entering the top-trade leaderboard',
};

/** The trigger event that is the canonical source for each badge type. */
export const BADGE_TRIGGER: Record<BadgeType, BadgeTriggerEvent> = {
   FIRST_BUYER: 'first_swap',
   WHALE_HOLDER: 'whale_swap',
   GOVERNANCE_VOTER: 'vote_cast',
   DIAMOND_HANDS: 'hold_milestone',
   TOP_TRADER: 'leaderboard_entry',
};
