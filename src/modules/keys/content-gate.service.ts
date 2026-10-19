// src/modules/keys/content-gate.service.ts
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson, cacheInvalidate, getRedis } from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';

export class KeyNotFoundError extends Error {
   constructor(keyId: string) {
      super(`Key not found: ${keyId}`);
      this.name = 'KeyNotFoundError';
   }
}

export type GateType = 'none' | 'hold_balance' | 'subscription' | 'nft_pass';

export interface ContentAccessResponse {
   key_id: string;
   wallet: string;
   is_allowed: boolean;
   gate_type: GateType;
   requirement: any | null;
}

export const CONTENT_GATE_CACHE_TTL_SECONDS = 30;

export function getContentAccessCacheKey(keyId: string, wallet: string): string {
   return `key:${keyId}:content-access:${wallet}`;
}

export async function invalidateContentAccessCache(keyId: string, wallet?: string): Promise<void> {
   try {
      if (wallet) {
         await cacheInvalidate(getContentAccessCacheKey(keyId, wallet));
      } else {
         await cacheInvalidate(`key:${keyId}:content-access:*`);
      }
   } catch (error) {
      logger.warn({ error, keyId, wallet }, 'Failed to invalidate content access cache');
   }
}

export async function checkContentAccess(
   keyId: string,
   wallet: string
): Promise<ContentAccessResponse> {
   const cacheKey = getContentAccessCacheKey(keyId, wallet);
   const cached = await cacheGetJson<ContentAccessResponse>(cacheKey);
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

   const gate = await prisma.keyContentGate.findUnique({
      where: { keyId },
   });

   if (!gate || !gate.isActive || gate.gateType === 'none') {
      const response: ContentAccessResponse = {
         key_id: keyId,
         wallet,
         is_allowed: true,
         gate_type: 'none',
         requirement: null,
      };

      try {
         await cacheSetJson(cacheKey, response, CONTENT_GATE_CACHE_TTL_SECONDS);
      } catch (err) {
         logger.warn({ err, keyId, wallet }, 'Failed to cache content access');
      }

      return response;
   }

   let parsedReq: any = {};
   try {
      parsedReq = JSON.parse(gate.requirement);
   } catch {
      parsedReq = gate.requirement;
   }

   let isAllowed = false;

   if (gate.gateType === 'hold_balance') {
      const minBalance = Number(parsedReq.min_balance || 1);
      const ownership = await prisma.keyOwnership.findUnique({
         where: {
            ownerAddress_creatorId: {
               ownerAddress: wallet,
               creatorId: keyId,
            },
         },
         select: { balance: true },
      });

      const currentBalance = ownership ? Number(ownership.balance.toString()) : 0;
      isAllowed = currentBalance >= minBalance;
   } else if (gate.gateType === 'subscription') {
      const redis = getRedis();
      const isMember = redis ? await redis.sismember(`key:${keyId}:subscribers`, wallet) : 0;
      isAllowed = isMember === 1;
   } else if (gate.gateType === 'nft_pass') {
      const requiredPassId = parsedReq.pass_id;
      if (!requiredPassId) {
         isAllowed = true;
      } else {
         const passOwnership = await prisma.keyOwnership.findUnique({
            where: {
               ownerAddress_creatorId: {
                  ownerAddress: wallet,
                  creatorId: requiredPassId,
               },
            },
            select: { balance: true },
         });
         isAllowed = passOwnership ? Number(passOwnership.balance.toString()) > 0 : false;
      }
   }

   const response: ContentAccessResponse = {
      key_id: keyId,
      wallet,
      is_allowed: isAllowed,
      gate_type: gate.gateType as GateType,
      requirement: parsedReq,
   };

   try {
      await cacheSetJson(cacheKey, response, CONTENT_GATE_CACHE_TTL_SECONDS);
   } catch (err) {
      logger.warn({ err, keyId, wallet }, 'Failed to cache content access');
   }

   return response;
}
