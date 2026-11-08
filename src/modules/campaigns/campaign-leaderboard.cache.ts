export const CAMPAIGN_LEADERBOARD_CACHE_TTL_SECONDS = 300;

/** Shared cache key used by reads and WalletQualified invalidation hooks. */
export function campaignLeaderboardCacheKey(campaignId: string, limit: number): string {
  return `campaign:${campaignId}:leaderboard:${limit}`;
}
