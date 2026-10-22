// src/modules/badges/index.ts
// Public surface of the key NFT badge minting trigger service (#1148).

export * from './badge.types';
export {
   BADGE_DESCRIPTIONS,
   BADGE_TRIGGER,
   whaleThresholdXlm,
   holdMilestoneDays,
   topTraderMaxRank,
   mintMaxAttempts,
} from './badge.constants';
export { mintBadge, type BadgeMintDeps } from './badge-mint.service';
export { evaluateEvent, processQualifyingEvent } from './badge-trigger.service';
export {
   DefaultBadgeMintContractClient,
   makeDefaultBadgeMintContractClient,
   defaultBadgeMintContractClient,
   BadgeMintSubmitError,
} from './badge-mint.client';
export {
   buildMintBadgeTransaction,
   BadgeContractUnavailableError,
} from './badge-mint.builder';
