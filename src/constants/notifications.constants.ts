// src/constants/notifications.constants.ts

export const NOTIFICATION_TYPES = {
   TRADE_COMPLETED: 'trade_completed',
   LOCKUP_EXPIRING: 'lockup_expiring',
   PRICE_MOVED: 'price_moved',
   PAUSE_PROPOSAL_CREATED: 'pause_proposal_created',
   TRADING_PAUSED: 'trading_paused',
   KEY_DEPRECATED: 'key_deprecated',
   KEY_SUNSET_FLAGGED: 'key_sunset_flagged',
   MILESTONE_CROSSED: 'milestone_crossed',
   CIRCUIT_BREAKER_TRIPPED: 'circuit_breaker_tripped',
} as const;

export type NotificationType =
  (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];

/** Lockup warnings fire when expiry is within this window. */
export const LOCKUP_WARNING_WINDOW_MS = 60 * 60 * 1000;

/** Absolute price move threshold that triggers price_moved (percent). */
export const PRICE_MOVED_THRESHOLD_PCT = 10;

export const REDIS_KEYS = {
  notificationsReadAt: (wallet: string) => `notifications:read_at:${wallet}`,
  keyFees: (keyId: string) => `key:fees:${keyId}`,
  keyAuction: (keyId: string) => `key:auction:${keyId}`,
  keyMetadata: (keyId: string) => `key:metadata:${keyId}`,
  keyStaking: (keyId: string) => `key:staking:${keyId}`,
  holderStaking: (keyId: string, holder: string) => `key:staking:holder:${keyId}:${holder}`,
  priceMovedSet: 'price_moved:keys',
  priceMovedDelivered: (keyId: string) => `price_moved:delivered:${keyId}`,
  keySunsetEvent: (eventId: string) => `key_sunset:dispatch:${eventId}`,
  keyDeprecationEvent: (eventId: string) => `key_deprecation:dispatch:${eventId}`,
} as const;

/** Trips surfaced as circuit_breaker_tripped notifications, newest first (#987). */
export const CIRCUIT_BREAKER_TRIP_NOTIFICATION_LIMIT = 50;

export const KEY_FEES_CACHE_TTL_SECONDS = 60;
export const KEY_AUCTION_CACHE_TTL_SECONDS = 30;
export const KEY_METADATA_CACHE_TTL_SECONDS = 300;
export const KEY_STAKING_CACHE_TTL_SECONDS = 60;
export const HOLDER_STAKING_CACHE_TTL_SECONDS = 30;
export const PRICE_MOVED_SET_TTL_SECONDS = 6 * 60 * 60;
export const KEY_SEARCH_MAX_RESULTS = 10;
export const KEY_SEARCH_MIN_QUERY_LENGTH = 2;
