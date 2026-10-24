// src/modules/keys/key-tipping.service.ts
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';

export class KeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'KeyNotFoundError';
   }
}

export class TipNotFoundError extends Error {
   constructor(tipId: string) {
      super(`Tip not found: ${tipId}`);
      this.name = 'TipNotFoundError';
   }
}

export interface KeyTipItem {
   id: string;
   tipper: string;
   amount: string;
   message_hash: string | null;
   message_cid: string | null;
   created_at: string;
}

export interface KeyTipsResponse {
   key_id: string;
   tips: KeyTipItem[];
   total: number;
   cursor?: string;
   has_more: boolean;
}

export interface KeyTipsTotalResponse {
   key_id: string;
   total_amount: string;
   tip_count: number;
}

export interface TipMessageResponse {
   tip_id: string;
   message_cid: string;
   content: string;
}

export const TIPPING_CACHE_TTL_SECONDS = 60;

export function getTipsListCacheKey(keyId: string, limit: number, cursor?: string): string {
   return `key:tips:${keyId}:${limit}:${cursor || 'start'}`;
}

export function getTipsTotalCacheKey(keyId: string): string {
   return `key:tips:total:${keyId}`;
}

export function getTipMessageCacheKey(tipId: string): string {
   return `key:tip:message:${tipId}`;
}

export async function invalidateKeyTipsCache(keyId: string): Promise<void> {
   try {
      await cacheInvalidate(getTipsTotalCacheKey(keyId));
      await cacheInvalidate(getTipsListCacheKey(keyId, 20));
      await cacheInvalidate(getTipsListCacheKey(keyId, 50));
   } catch (error) {
      logger.warn({ error, keyId }, 'Failed to invalidate key tips cache');
   }
}

export async function getKeyTips(
   keyId: string,
   limit = 20,
   cursor?: string
): Promise<KeyTipsResponse> {
   const safeLimit = Math.min(Math.max(1, limit), 100);
   const cacheKey = getTipsListCacheKey(keyId, safeLimit, cursor);

   const cached = await cacheGetJson<KeyTipsResponse>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   const creator = await prisma.creatorProfile.findUnique({
      where: { id: keyId },
      select: { id: true },
   });

   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const tips = await prisma.keyTip.findMany({
      where: { keyId },
      orderBy: { createdAt: 'desc' },
      take: safeLimit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      skip: cursor ? 1 : 0,
   });

   const hasMore = tips.length > safeLimit;
   const items = hasMore ? tips.slice(0, safeLimit) : tips;
   const nextCursor = hasMore ? items[items.length - 1].id : undefined;

   const result: KeyTipsResponse = {
      key_id: keyId,
      tips: items.map(t => ({
         id: t.id,
         tipper: t.tipper,
         amount: t.amount.toString(),
         message_hash: t.messageHash,
         message_cid: t.messageCid,
         created_at: t.createdAt.toISOString(),
      })),
      total: items.length,
      cursor: nextCursor,
      has_more: hasMore,
   };

   try {
      await cacheSetJson(cacheKey, result, TIPPING_CACHE_TTL_SECONDS);
   } catch (error) {
      logger.warn({ error, keyId }, 'Failed to cache key tips');
   }

   return result;
}

export async function getKeyTipsTotal(keyId: string): Promise<KeyTipsTotalResponse> {
   const cacheKey = getTipsTotalCacheKey(keyId);
   const cached = await cacheGetJson<KeyTipsTotalResponse>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   const creator = await prisma.creatorProfile.findUnique({
      where: { id: keyId },
      select: { id: true },
   });

   if (!creator) {
      throw new KeyNotFoundError(keyId);
   }

   const [aggregate, count] = await Promise.all([
      prisma.keyTip.aggregate({
         where: { keyId },
         _sum: { amount: true },
      }),
      prisma.keyTip.count({
         where: { keyId },
      }),
   ]);

   const totalAmount = aggregate._sum.amount ? aggregate._sum.amount.toString() : '0';

   const result: KeyTipsTotalResponse = {
      key_id: keyId,
      total_amount: totalAmount,
      tip_count: count,
   };

   try {
      await cacheSetJson(cacheKey, result, TIPPING_CACHE_TTL_SECONDS);
   } catch (error) {
      logger.warn({ error, keyId }, 'Failed to cache tips total');
   }

   return result;
}

export async function getTipMessage(keyId: string, tipId: string): Promise<TipMessageResponse> {
   const cacheKey = getTipMessageCacheKey(tipId);
   const cached = await cacheGetJson<TipMessageResponse>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   const tip = await prisma.keyTip.findFirst({
      where: { id: tipId, keyId },
   });

   if (!tip) {
      throw new TipNotFoundError(tipId);
   }

   const content = tip.messageText || (tip.messageCid ? `IPFS content for ${tip.messageCid}` : '');

   const result: TipMessageResponse = {
      tip_id: tipId,
      message_cid: tip.messageCid || '',
      content: content,
   };

   try {
      await cacheSetJson(cacheKey, result, 3600); // cache message content for 1 hour
   } catch (error) {
      logger.warn({ error, tipId }, 'Failed to cache tip message');
   }

   return result;
}
