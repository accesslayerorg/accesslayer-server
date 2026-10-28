// src/modules/tips/tips.service.ts
//
// Read model for per-key tip history (#1132), backed by the `key_tips` /
// `key_tip_totals` tables maintained from TipSent contract events.
//
// - GET /keys/:key_id/tips         — cursor-paginated tip history
// - GET /keys/:key_id/tips/total   — cumulative tips received
// - GET /keys/:key_id/tips/:tipId/content — IPFS tip message content,
//   fetched on demand from the Pinata gateway and cached in Redis.
//
// List/total responses are cached for 60s and invalidated per key by the
// tip indexer after every TipSent event. Fetched IPFS content is cached
// for an hour (immutable per CID).

import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
} from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';
import {
   KEY_TIP_CONTENT_CACHE_TTL_SECONDS,
   KEY_TIPS_CACHE_TTL_SECONDS,
   keyTipContentCacheKey,
   keyTipsCachePattern,
   keyTipsListCacheKey,
   keyTipsTotalCacheKey,
} from '../../constants/redis.constants';
import {
   normalizeIpfsCid,
   resolvePinataGatewayUrl,
} from '../../utils/pinata-gateway.utils';
import { resolveCreatorId } from '../whitelist/whitelist.service';

/** One tip in the history. */
export interface TipHistoryItem {
   id: string;
   tipper: string;
   amount: string;
   message_hash: string | null;
   tipped_at: string;
   tx_hash: string | null;
}

/** Cursor-paginated tip history page. */
export interface TipHistoryPage {
   key_id: string;
   data: TipHistoryItem[];
   meta: {
      hasMore: boolean;
      nextCursor: string | null;
   };
}

/** Cumulative tip totals for a key. */
export interface TipTotals {
   key_id: string;
   total: string;
   count: number;
}

/** Maximum IPFS message size fetched for the content endpoint (256 KiB). */
export const MAX_TIP_MESSAGE_BYTES = 256 * 1024;

/** IPFS gateway fetch timeout (ms). */
export const TIP_MESSAGE_FETCH_TIMEOUT_MS = 5000;

/**
 * Drops every cached tip response for a key (list + total). Called by the
 * indexer after every TipSent event.
 */
export async function invalidateKeyTipsCache(keyId: string): Promise<void> {
   await cacheInvalidate(keyTipsCachePattern(keyId));
}

/**
 * Maps any key identifier to the canonical CreatorProfile.id used as
 * `keyId` in the key_tips table.
 */
export async function resolveTipKeyId(keyId: string): Promise<string> {
   return (await resolveCreatorId(keyId)) ?? keyId;
}

/**
 * Lists tip history for a key, newest first, cursor-paginated by tip id.
 */
export async function listTips(
   keyId: string,
   limit: number,
   cursor?: string
): Promise<TipHistoryPage> {
   const resolvedKeyId = await resolveTipKeyId(keyId);
   const cacheKey = keyTipsListCacheKey(
      resolvedKeyId,
      limit,
      cursor ?? 'start'
   );

   try {
      const cached = await cacheGetJson<TipHistoryPage>(cacheKey);
      if (cached !== null) {
         logger.debug({ keyId: resolvedKeyId }, 'Tip list cache hit');
         return cached;
      }
   } catch {
      // Cache read failures fall through to the database.
   }

   const rows = await prisma.keyTip.findMany({
      where: { keyId: resolvedKeyId },
      orderBy: { tippedAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
         id: true,
         tipper: true,
         amount: true,
         messageHash: true,
         tippedAt: true,
         txHash: true,
      },
   });

   const hasMore = rows.length > limit;
   const page = hasMore ? rows.slice(0, limit) : rows;
   const lastRow = page[page.length - 1];

   const result: TipHistoryPage = {
      key_id: resolvedKeyId,
      data: page.map(row => ({
         id: row.id,
         tipper: row.tipper,
         amount: Number(row.amount).toFixed(7),
         message_hash: row.messageHash,
         tipped_at: row.tippedAt.toISOString(),
         tx_hash: row.txHash,
      })),
      meta: {
         hasMore,
         nextCursor: hasMore && lastRow ? lastRow.id : null,
      },
   };

   try {
      await cacheSetJson(cacheKey, result, KEY_TIPS_CACHE_TTL_SECONDS);
   } catch {
      // Cache write failures are non-critical.
   }

   return result;
}

/**
 * Returns the cumulative tips received by a key. Keys with no tips report
 * a zero total (not 404).
 */
export async function getTipTotals(keyId: string): Promise<TipTotals> {
   const resolvedKeyId = await resolveTipKeyId(keyId);
   const cacheKey = keyTipsTotalCacheKey(resolvedKeyId);

   try {
      const cached = await cacheGetJson<TipTotals>(cacheKey);
      if (cached !== null) {
         logger.debug({ keyId: resolvedKeyId }, 'Tip total cache hit');
         return cached;
      }
   } catch {
      // Cache read failures fall through to the database.
   }

   const row = await prisma.keyTipTotal.findUnique({
      where: { keyId: resolvedKeyId },
      select: { total: true, count: true },
   });

   const result: TipTotals = {
      key_id: resolvedKeyId,
      total: Number(row?.total ?? 0).toFixed(7),
      count: row?.count ?? 0,
   };

   try {
      await cacheSetJson(cacheKey, result, KEY_TIPS_CACHE_TTL_SECONDS);
   } catch {
      // Cache write failures are non-critical.
   }

   return result;
}

/** Content fetched from IPFS for a tip message. */
export interface TipMessageContent {
   message_hash: string;
   content: string;
}

/**
 * Fetches (or returns cached) IPFS message content for a tip. Returns
 * null when the tip or its message hash is unknown; throws on gateway
 * failure.
 */
export async function getTipMessageContent(
   keyId: string,
   tipId: string
): Promise<TipMessageContent | null> {
   const resolvedKeyId = await resolveTipKeyId(keyId);

   const tip = await prisma.keyTip.findFirst({
      where: { id: tipId, keyId: resolvedKeyId },
      select: { messageHash: true },
   });

   if (!tip?.messageHash) {
      return null;
   }

   const messageHash = tip.messageHash;
   const cacheKey = keyTipContentCacheKey(messageHash);

   try {
      const cached = await cacheGetJson<TipMessageContent>(cacheKey);
      if (cached !== null) {
         logger.debug({ messageHash }, 'Tip message content cache hit');
         return cached;
      }
   } catch {
      // Cache read failures fall through to the gateway.
   }

   const cid = normalizeIpfsCid(messageHash);
   if (!cid) {
      return null;
   }
   const url = resolvePinataGatewayUrl(cid);
   if (!url) {
      throw new Error('No IPFS gateway configured (PINATA_GATEWAY_URL)');
   }

   const controller = new AbortController();
   const timeout = setTimeout(
      () => controller.abort(),
      TIP_MESSAGE_FETCH_TIMEOUT_MS
   );

   try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
         throw new Error(
            `IPFS gateway returned ${response.status} for ${cid}`
         );
      }

      const contentLength = Number(response.headers.get('content-length'));
      if (
         Number.isFinite(contentLength) &&
         contentLength > MAX_TIP_MESSAGE_BYTES
      ) {
         throw new Error(`IPFS message exceeds ${MAX_TIP_MESSAGE_BYTES} bytes`);
      }

      const text = await response.text();
      if (text.length > MAX_TIP_MESSAGE_BYTES) {
         throw new Error(`IPFS message exceeds ${MAX_TIP_MESSAGE_BYTES} bytes`);
      }

      const result: TipMessageContent = { message_hash: messageHash, content: text };

      try {
         await cacheSetJson(
            cacheKey,
            result,
            KEY_TIP_CONTENT_CACHE_TTL_SECONDS
         );
      } catch {
         // Cache write failures are non-critical.
      }

      return result;
   } catch (error) {
      logger.warn(
         { messageHash, error: (error as Error).message },
         'Failed to fetch tip message content from IPFS gateway'
      );
      throw error;
   } finally {
      clearTimeout(timeout);
   }
}
