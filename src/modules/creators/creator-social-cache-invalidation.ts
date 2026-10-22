// src/modules/creators/creator-social-cache-invalidation.ts
//
// Cache invalidation for creator social metadata.
//
// Social metadata is synced from on-chain SocialMetadataUpdated events. Any
// cached creator-derived response (creator feed/list, profile detail) can go
// stale the moment a new event lands, so the indexer handler calls
// `invalidateCreatorSocialMetadataCache` synchronously after each successful
// sync. In-memory invalidation is immediate; HTTP-facing staleness is bounded
// by the per-route Cache-Control max-age (see CREATOR_SOCIAL_CACHE_MAX_AGE).

import { logger } from '../../utils/logger.utils';
import { resetCreatorListCache } from './creators.cache';
import { CREATOR_FEED_CACHE_INVALIDATION_TOUCHPOINTS } from './creators-cache-key.utils';

export interface CreatorSocialCacheInvalidationContext {
   /** Creator profile id the social metadata belongs to. */
   creatorId: string;
   /** Transaction hash of the SocialMetadataUpdated event (when known). */
   txHash?: string;
   /** Event index within the transaction (when known). */
   eventIndex?: number;
}

/**
 * Invalidates every server-side cache that can serve stale creator social
 * metadata after a SocialMetadataUpdated event.
 *
 * - Resets the in-memory creator feed/list cache (all entries; the feed
 *   ordering and summaries can shift when social metadata changes).
 * - Emits a structured log entry so invalidation latency can be monitored
 *   against the 60-second freshness requirement.
 *
 * This function is synchronous and must be invoked right after the social
 * metadata snapshot write so the data becomes invisible to cached reads
 * within milliseconds of the update event.
 */
export function invalidateCreatorSocialMetadataCache(
   context: CreatorSocialCacheInvalidationContext
): void {
   resetCreatorListCache();

   logger.info(
      {
         event: 'creator_social_cache_invalidated',
         touchpoint:
            CREATOR_FEED_CACHE_INVALIDATION_TOUCHPOINTS.CREATOR_SOCIAL_METADATA_UPDATED,
         creator_id: context.creatorId,
         tx_hash: context.txHash ?? null,
         event_index: context.eventIndex ?? null,
         invalidated_at: new Date().toISOString(),
      },
      'Creator social metadata caches invalidated'
   );
}
