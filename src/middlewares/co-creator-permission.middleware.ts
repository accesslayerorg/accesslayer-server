// src/middlewares/co-creator-permission.middleware.ts
import { Request, Response, NextFunction } from 'express';
import { prisma } from '../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../utils/redis.utils';
import { logger } from '../utils/logger.utils';

export type RequiredCoCreatorRole = 'ADMIN' | 'CONTENT' | 'REVENUE';

export const COCREATOR_ROLE_CACHE_TTL_SECONDS = 60;

export function getCoCreatorRoleCacheKey(keyId: string, wallet: string): string {
   return `key:co-creator:role:${keyId}:${wallet}`;
}

export function validateCoCreatorPermission(requiredRole: RequiredCoCreatorRole) {
   return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
         const rawKeyId = req.params.keyId || req.params.key_id;
         const keyId = Array.isArray(rawKeyId) ? rawKeyId[0] : rawKeyId;
         // Extract wallet from auth user, header, or query
         const rawWallet =
            (req as any).user?.wallet ||
            (req as any).user?.address ||
            (req as any).user?.sub ||
            (req.headers['x-wallet-address'] as string);
         const wallet = Array.isArray(rawWallet) ? rawWallet[0] : rawWallet;

         if (!keyId || !wallet) {
            res.status(403).json({
               success: false,
               error: {
                  code: 'FORBIDDEN',
                  message: 'Key ID and authenticated wallet are required',
                  role_required: requiredRole,
                  current_role: 'NONE',
               },
            });
            return;
         }

         // 1. Primary creator check - primary creator bypasses co-creator check
         const creator = await prisma.creatorProfile.findUnique({
            where: { id: keyId },
            select: { id: true, userId: true, handle: true },
         });

         if (creator && (creator.userId === wallet || creator.handle === wallet)) {
            next();
            return;
         }

         // 2. Check cached role
         const cacheKey = getCoCreatorRoleCacheKey(keyId, wallet);
         let currentRole = await cacheGetJson<string>(cacheKey);

         if (currentRole === null) {
            const record = await prisma.keyCoCreator.findFirst({
               where: {
                  keyId,
                  wallet,
                  isActive: true,
               },
               select: { role: true },
            });

            currentRole = record ? record.role.toUpperCase() : 'NONE';
            try {
               await cacheSetJson(cacheKey, currentRole, COCREATOR_ROLE_CACHE_TTL_SECONDS);
            } catch (err) {
               logger.warn({ err, keyId, wallet }, 'Failed to cache co-creator role');
            }
         }

         // 3. Permission evaluation
         // - ADMIN passes all endpoints
         // - CONTENT passes ANNOUNCEMENTS / CONTENT
         // - REVENUE passes REVENUE
         let isAllowed = false;

         if (currentRole === 'ADMIN') {
            isAllowed = true;
         } else if (currentRole === 'CONTENT' && requiredRole === 'CONTENT') {
            isAllowed = true;
         } else if (currentRole === 'REVENUE' && requiredRole === 'REVENUE') {
            isAllowed = true;
         }

         if (isAllowed) {
            next();
            return;
         }

         res.status(403).json({
            success: false,
            error: {
               code: 'FORBIDDEN',
               message: 'Access denied: insufficient co-creator permissions',
               role_required: requiredRole,
               current_role: currentRole,
            },
         });
      } catch (error) {
         logger.error({ error }, 'Co-creator permission validation error');
         res.status(500).json({
            success: false,
            error: {
               code: 'INTERNAL_ERROR',
               message: 'Internal permission verification error',
            },
         });
      }
   };
}
