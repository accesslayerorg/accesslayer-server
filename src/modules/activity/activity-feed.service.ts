// src/modules/activity/activity-feed.service.ts
//
// Platform-wide activity feed (#936): the last 20 events across the whole
// platform, reverse-chronological, with cursor pagination for older pages.
//
// The Activity model's ActivityType enum is an internal/technical taxonomy
// (KEY_BOUGHT, DIVIDEND_DISTRIBUTED, ...). The public feed exposes a small,
// stable set of event type strings instead, so this module maps enum values
// onto them.

import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
} from '../../utils/redis.utils';
import { truncateWallet } from '../../utils/wallet-display.utils';
import { paginateQuery } from '../../utils/pagination.utils';
import {
   PlatformActivityEventType,
   PlatformActivityFeedItem,
} from './activity-feed.schemas';

export const ACTIVITY_FEED_PAGE_SIZE = 20;
export const ACTIVITY_FEED_CACHE_KEY = 'activity:feed:v1';
export const ACTIVITY_FEED_CACHE_TTL_SECONDS = 30;

/**
 * Maps the internal ActivityType enum onto the public-facing event type
 * strings the platform feed exposes. Types not in this map are excluded from
 * the feed entirely (e.g. PROFILE_UPDATED has no public-facing equivalent).
 */
const ACTIVITY_TYPE_TO_FEED_EVENT: Partial<
   Record<string, PlatformActivityEventType>
> = {
   KEY_BOUGHT: 'investment',
   DIVIDEND_DISTRIBUTED: 'settlement',
   CREATOR_REGISTERED: 'new_listing',
   SUPPLY_FULLY_FUNDED: 'fully_funded',
};

const FEED_ACTIVITY_TYPES = Object.keys(ACTIVITY_TYPE_TO_FEED_EVENT);

function mapToFeedItem(activity: {
   id: string;
   type: string;
   actor: string;
   payload: unknown;
   createdAt: Date;
}): PlatformActivityFeedItem | null {
   const eventType = ACTIVITY_TYPE_TO_FEED_EVENT[activity.type];
   if (!eventType) return null;

   const payload = (activity.payload as Record<string, unknown>) || {};
   const rawAmount =
      payload.amount ?? payload.price ?? payload.dividendAmount ?? null;

   return {
      type: eventType,
      invoice_id: activity.id,
      amount:
         rawAmount === null || rawAmount === undefined
            ? null
            : String(rawAmount),
      wallet: activity.actor ? truncateWallet(activity.actor) : '',
      timestamp: activity.createdAt.toISOString(),
   };
}

export interface ActivityFeedResult {
   items: PlatformActivityFeedItem[];
   next_cursor: string | null;
   has_more: boolean;
}

/**
 * Fetches the platform activity feed. The uncursored first page is cached
 * for 30s (ACTIVITY_FEED_CACHE_TTL_SECONDS); subsequent cursor pages read
 * through to the database since they represent immutable older history.
 */
export async function getActivityFeed(
   cursor?: string
): Promise<ActivityFeedResult> {
   if (!cursor) {
      const cached = await cacheGetJson<ActivityFeedResult>(
         ACTIVITY_FEED_CACHE_KEY
      );
      if (cached !== null) {
         return cached;
      }
   }

   const { data, nextCursor, hasMore } = await paginateQuery(
      args =>
         prisma.activity.findMany({
            where: { type: { in: FEED_ACTIVITY_TYPES as any } },
            orderBy: { createdAt: 'desc' },
            ...args,
         }),
      {
         cursor: cursor ? { id: cursor } : undefined,
         limit: ACTIVITY_FEED_PAGE_SIZE,
      }
   );

   const items = data
      .map(mapToFeedItem)
      .filter((item): item is PlatformActivityFeedItem => item !== null);

   const result: ActivityFeedResult = {
      items,
      next_cursor: hasMore ? (nextCursor ?? null) : null,
      has_more: hasMore,
   };

   if (!cursor) {
      await cacheSetJson(
         ACTIVITY_FEED_CACHE_KEY,
         result,
         ACTIVITY_FEED_CACHE_TTL_SECONDS
      );
   }

   return result;
}

/** Invalidate the cached first page. Call this whenever a new Activity row is created. */
export async function invalidateActivityFeedCache(): Promise<void> {
   await cacheInvalidate(ACTIVITY_FEED_CACHE_KEY);
}
