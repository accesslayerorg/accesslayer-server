// src/modules/keys/key-cocreator.service.ts
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate } from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';

export class KeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'KeyNotFoundError';
   }
}

export class CoCreatorNotFoundError extends Error {
   constructor(keyId: string, wallet: string) {
      super(`Co-creator not found for key ${keyId} and wallet ${wallet}`);
      this.name = 'CoCreatorNotFoundError';
   }
}

export interface CoCreatorItem {
   wallet: string;
   role: string;
   added_at: string;
}

export interface CoCreatorDetailResponse {
   key_id: string;
   wallet: string;
   role: string;
   added_at: string;
}

export interface CoCreatorListResponse {
   key_id: string;
   co_creators: CoCreatorItem[];
   total: number;
}

export const COCREATOR_CACHE_TTL_SECONDS = 60;

export function getCoCreatorListCacheKey(keyId: string): string {
   return `key:co-creators:${keyId}`;
}

export function getCoCreatorDetailCacheKey(keyId: string, wallet: string): string {
   return `key:co-creators:${keyId}:${wallet}`;
}

export async function invalidateCoCreatorCache(keyId: string, wallet?: string): Promise<void> {
   try {
      await cacheInvalidate(getCoCreatorListCacheKey(keyId));
      if (wallet) {
         await cacheInvalidate(getCoCreatorDetailCacheKey(keyId, wallet));
      }
   } catch (error) {
      logger.warn({ error, keyId, wallet }, 'Failed to invalidate co-creator cache');
   }
}

export async function getCoCreators(keyId: string): Promise<CoCreatorListResponse> {
   const cacheKey = getCoCreatorListCacheKey(keyId);
   const cached = await cacheGetJson<CoCreatorListResponse>(cacheKey);
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

   const list = await prisma.keyCoCreator.findMany({
      where: { keyId, isActive: true },
      orderBy: { addedAt: 'asc' },
      select: {
         wallet: true,
         role: true,
         addedAt: true,
      },
   });

   const result: CoCreatorListResponse = {
      key_id: keyId,
      co_creators: list.map(item => ({
         wallet: item.wallet,
         role: item.role,
         added_at: item.addedAt.toISOString(),
      })),
      total: list.length,
   };

   try {
      await cacheSetJson(cacheKey, result, COCREATOR_CACHE_TTL_SECONDS);
   } catch (error) {
      logger.warn({ error, keyId }, 'Failed to cache co-creator list');
   }

   return result;
}

export async function getCoCreatorDetail(
   keyId: string,
   wallet: string
): Promise<CoCreatorDetailResponse> {
   const cacheKey = getCoCreatorDetailCacheKey(keyId, wallet);
   const cached = await cacheGetJson<CoCreatorDetailResponse>(cacheKey);
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

   const coCreator = await prisma.keyCoCreator.findFirst({
      where: { keyId, wallet, isActive: true },
      select: {
         wallet: true,
         role: true,
         addedAt: true,
      },
   });

   if (!coCreator) {
      throw new CoCreatorNotFoundError(keyId, wallet);
   }

   const result: CoCreatorDetailResponse = {
      key_id: keyId,
      wallet: coCreator.wallet,
      role: coCreator.role,
      added_at: coCreator.addedAt.toISOString(),
   };

   try {
      await cacheSetJson(cacheKey, result, COCREATOR_CACHE_TTL_SECONDS);
   } catch (error) {
      logger.warn({ error, keyId, wallet }, 'Failed to cache co-creator detail');
   }

   return result;
}
