export const DUTCH_AUCTION_STATUSES = [
   'open',
   'filled',
   'cancelled',
   'ended',
] as const;

export type DutchAuctionStatus = (typeof DUTCH_AUCTION_STATUSES)[number];

/** Approximate Stellar ledger close time, used only to estimate timestamps. */
export const SECONDS_PER_LEDGER = 5;

/** Listing responses are cached for this long. */
export const DUTCH_AUCTION_LIST_CACHE_TTL_SECONDS = 5;

export const DUTCH_AUCTION_DEFAULT_LIMIT = 20;
export const DUTCH_AUCTION_MAX_LIMIT = 100;

export function dutchAuctionListCacheKey(parts: {
   keyId?: string;
   status: string;
   cursor?: string;
   limit: number;
}): string {
   return `dutch-auctions:list:${parts.keyId ?? '*'}:${parts.status}:${parts.limit}:${parts.cursor ?? ''}`;
}
