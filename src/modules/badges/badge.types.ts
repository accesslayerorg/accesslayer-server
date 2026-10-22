// src/modules/badges/badge.types.ts
// Shared types for the key NFT badge minting trigger service (#1148).

/** Badge kinds the trigger service can award. */
export type BadgeType =
   | 'FIRST_BUYER'
   | 'WHALE_HOLDER'
   | 'GOVERNANCE_VOTER'
   | 'DIAMOND_HANDS'
   | 'TOP_TRADER';

export const BADGE_TYPES: BadgeType[] = [
   'FIRST_BUYER',
   'WHALE_HOLDER',
   'GOVERNANCE_VOTER',
   'DIAMOND_HANDS',
   'TOP_TRADER',
];

export function isBadgeType(value: string): value is BadgeType {
   return BADGE_TYPES.includes(value as BadgeType);
}

/** Qualifying on-chain event that triggered an award (stored for audit). */
export type BadgeTriggerEvent =
   | 'first_swap'
   | 'whale_swap'
   | 'vote_cast'
   | 'hold_milestone'
   | 'leaderboard_entry';

/** Lifecycle status of a badge mint log row. */
export type BadgeMintStatus = 'PENDING' | 'MINTED' | 'FAILED';

// ── Qualifying events consumed by the trigger service ──────────────────────

/** A swap/first-buy. Can qualify for FIRST_BUYER and/or WHALE_HOLDER. */
export interface SwapQualifyingEvent {
   kind: 'swap';
   wallet: string;
   /** Trade size in XLM; compared against the whale threshold. */
   amount: number;
   /** Whether this is the wallet's first-ever swap (from the indexer). */
   isFirstSwap: boolean;
   txHash?: string;
}

/** A governance vote cast. Qualifies for GOVERNANCE_VOTER. */
export interface VoteQualifyingEvent {
   kind: 'vote';
   wallet: string;
   proposalId: string;
   txHash?: string;
}

/** A long-term hold milestone. Qualifies for DIAMOND_HANDS at 365d. */
export interface HoldQualifyingEvent {
   kind: 'hold';
   wallet: string;
   /** Continuous hold duration in days. */
   holdDurationDays: number;
   txHash?: string;
}

/** A leaderboard entry. Qualifies for TOP_TRADER when inside the top rank. */
export interface LeaderboardQualifyingEvent {
   kind: 'leaderboard';
   wallet: string;
   /** 1-based leaderboard rank. */
   rank: number;
   txHash?: string;
}

export type QualifyingEvent =
   | SwapQualifyingEvent
   | VoteQualifyingEvent
   | HoldQualifyingEvent
   | LeaderboardQualifyingEvent;

/** A single badge award derived from a qualifying event. */
export interface BadgeAward {
   wallet: string;
   badgeType: BadgeType;
   triggerEvent: BadgeTriggerEvent;
   /** Qualifying context persisted alongside the mint log row. */
   metadata?: Record<string, unknown>;
}

/**
 * On-chain client that mints a badge for a wallet. Injectable so the service
 * can be unit-tested without a Soroban RPC. Mirrors the campaign contract
 * client's dual camelCase/snake_case surface.
 */
export interface BadgeMintContractClient {
   mintBadge(
      wallet: string,
      badgeType: BadgeType
   ): Promise<{ txHash?: string }>;
   mint_badge?(
      wallet: string,
      badge_type: BadgeType
   ): Promise<{ txHash?: string }>;
}

/** Terminal outcome of a single `mintBadge` attempt sequence. */
export interface BadgeMintResult {
   wallet: string;
   badgeType: BadgeType;
   /** MINTED on success, SKIPPED when already earned, FAILED otherwise. */
   status: 'MINTED' | 'SKIPPED' | 'FAILED';
   txHash?: string;
   attempts: number;
   /** Reason a mint was skipped (e.g. already earned). */
   reason?: string;
   /** Error message when status is FAILED. */
   error?: string;
}

/** Aggregate outcome of processing one qualifying event. */
export interface ProcessEventResult {
   awards: BadgeMintResult[];
}
