// src/modules/referrals/referrals.constants.ts
// Tunables for the referral programme (#910).

/** Number of characters in a generated referral code. */
export const REFERRAL_CODE_LENGTH = 10;

/**
 * Alphabet for generated referral codes. Crockford-style base32 without the
 * visually ambiguous characters (0, 1, I, O) so codes stay readable when
 * shared verbally.
 */
export const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Number of attempts before giving up on generating a unique referral code.
 * Collisions are astronomically unlikely at the lengths above; the retry loop
 * exists so a collision can never fail a request.
 */
export const REFERRAL_CODE_MAX_ATTEMPTS = 5;

/** Default number of referred wallets returned by GET /referrals/referred. */
export const DEFAULT_REFERRED_PAGE_SIZE = 20;

/** Decimal places kept for XLM amounts (matches the Stellar precision). */
export const XLM_DECIMALS = 7;

/** Referral tier thresholds and multipliers. */
export const REFERRAL_TIERS = [
  { minReferrals: 0, maxReferrals: 9, multiplier: 1.0, name: 'BRONZE' },
  { minReferrals: 10, maxReferrals: 49, multiplier: 1.5, name: 'SILVER' },
  { minReferrals: 50, maxReferrals: Number.MAX_SAFE_INTEGER, multiplier: 2.0, name: 'GOLD' },
] as const;

export type ReferralTierName = (typeof REFERRAL_TIERS)[number]['name'];

/**
 * Returns the tier multiplier for a given referral count.
 */
export function getTierMultiplier(referralCount: number): number {
  const tier = REFERRAL_TIERS.find(
    (t) => referralCount >= t.minReferrals && referralCount <= t.maxReferrals
  );
  return tier?.multiplier ?? 1.0;
}

/**
 * Returns the tier name for a given referral count.
 */
export function getTierName(referralCount: number): ReferralTierName {
  const tier = REFERRAL_TIERS.find(
    (t) => referralCount >= t.minReferrals && referralCount <= t.maxReferrals
  );
  return tier?.name ?? 'BRONZE';
}
