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
