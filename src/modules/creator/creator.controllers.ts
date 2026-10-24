// src/modules/creator/creator.controllers.ts
// Performance bond status endpoints for creator keys.

import { Request, Response, NextFunction } from 'express';
import { prisma } from '../../utils/prisma.utils';
import { getBondStatus } from '../../clients/bond.client';

const BOND_CACHE_TTL_MS = 60_000;

interface BondCacheEntry {
   value: BondStatusView;
   fetchedAt: number;
   refreshing: boolean;
}

export interface BondStatusView {
   keyId: string;
   creator: string;
   amount: string;
   state: 'deposited' | 'released' | 'forfeited';
}

const bondCache = new Map<string, BondCacheEntry>();

/**
 * Returns bond state for a key using a 60s stale-while-revalidate cache.
 * Fresh entries are served directly; stale entries are served immediately
 * while a background refresh updates the cache.
 */
async function getCachedBondStatus(keyId: string): Promise<BondStatusView | null> {
   const cached = bondCache.get(keyId);
   const now = Date.now();

   if (cached) {
      const isStale = now - cached.fetchedAt >= BOND_CACHE_TTL_MS;
      if (!isStale) {
         return cached.value;
      }
      if (!cached.refreshing) {
         cached.refreshing = true;
         refreshBond(keyId).catch(() => {
            const entry = bondCache.get(keyId);
            if (entry) entry.refreshing = false;
         });
      }
      return cached.value;
   }

   return refreshBond(keyId);
}

async function refreshBond(keyId: string): Promise<BondStatusView | null> {
   const status = await getBondStatus(keyId);
   if (!status) {
      bondCache.delete(keyId);
      return null;
   }
   bondCache.set(keyId, {
      value: status,
      fetchedAt: Date.now(),
      refreshing: false,
   });
   return status;
}

/** GET /keys/:key_id/bond */
export async function getKeyBond(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const keyId = req.params.key_id;
      const bond = await getCachedBondStatus(keyId);

      if (!bond) {
         res.status(404).json({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Bond not found for key' },
         });
         return;
      }

      res.json({ success: true, data: bond });
   } catch (error) {
      next(error);
   }
}

/** GET /keys/:key_id/bond/history */
export async function getKeyBondHistory(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const keyId = req.params.key_id;

      const bond = await getCachedBondStatus(keyId);
      if (!bond) {
         res.status(404).json({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Bond not found for key' },
         });
         return;
      }

      const records = await prisma.bondForfeiture.findMany({
         where: { keyId },
         orderBy: { timestamp: 'desc' },
         select: { reason: true, timestamp: true, amount: true, txHash: true },
      });

      res.json({
         success: true,
         data: {
            items: records.map((r) => ({
               reason: r.reason,
               timestamp: r.timestamp.toISOString(),
               amount: r.amount.toString(),
               txHash: r.txHash,
            })),
         },
      });
   } catch (error) {
      next(error);
   }
}
