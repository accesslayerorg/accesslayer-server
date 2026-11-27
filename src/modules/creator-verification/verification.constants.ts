// src/modules/creator-verification/verification.constants.ts
// Vocabulary and limits for creator verification (#1324).

export const VERIFICATION_STATUSES = [
   'submitted',
   'in_review',
   'approved',
   'rejected',
] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** Workflow: a claim moves `submitted` to `in_review`; a decision closes it. */
export const VERIFICATION_TRANSITIONS: Record<VerificationStatus, readonly VerificationStatus[]> = {
   submitted: ['in_review'],
   in_review: ['approved', 'rejected'],
   approved: [],
   rejected: [],
};

export const PROOF_PROVIDERS = ['twitter', 'github', 'website'] as const;
export type ProofProvider = (typeof PROOF_PROVIDERS)[number];

/**
 * Hosts accepted for each provider. `website` accepts any public HTTPS host,
 * since the creator controls it.
 */
export const PROOF_PROVIDER_HOSTS: Readonly<Record<Exclude<ProofProvider, 'website'>, readonly string[]>> = {
   twitter: ['x.com', 'twitter.com'],
   github: ['github.com'],
};

export const MAX_PROOF_LINKS = 5;
export const MAX_PROOF_URL_LENGTH = 2048;
export const PROOF_FETCH_TIMEOUT_MS = 10_000;
/** Pages are read up to this many characters; a proof code is a short token. */
export const PROOF_MAX_BODY_CHARS = 1_000_000;
export const PROOF_CODE_PREFIX = 'AL-VERIFY-';
