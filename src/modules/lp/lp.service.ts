// src/modules/lp/lp.service.ts
//
// LP position and rewards API (#980).

import { prisma } from '../../utils/prisma.utils';

export class LpPositionNotFoundError extends Error {
   constructor(lpId: string) {
      super(`LP position not found: ${lpId}`);
      this.name = 'LpPositionNotFoundError';
   }
}

export interface LpPositionSummary {
   lpId: string;
   wallet: string;
   keyId: string;
   sharePercent: string;
   accruedRewards: string;
   status: string;
   createdAt: string;
   updatedAt: string;
}

function toSummary(position: {
   lpId: string;
   wallet: string;
   keyId: string;
   sharePercent: unknown;
   accruedRewards: unknown;
   status: string;
   createdAt: Date;
   updatedAt: Date;
}): LpPositionSummary {
   return {
      lpId: position.lpId,
      wallet: position.wallet,
      keyId: position.keyId,
      sharePercent: String(position.sharePercent),
      accruedRewards: String(position.accruedRewards),
      status: position.status,
      createdAt: position.createdAt.toISOString(),
      updatedAt: position.updatedAt.toISOString(),
   };
}

/** All active LP positions for a wallet. */
export async function getLpPositionsByWallet(
   wallet: string
): Promise<LpPositionSummary[]> {
   const positions = await prisma.lpPosition.findMany({
      where: { wallet, status: 'active' },
      orderBy: { createdAt: 'desc' },
   });
   return positions.map(toSummary);
}

/**
 * Single LP position by lpId, scoped to the owning wallet. Throws
 * LpPositionNotFoundError both when the position doesn't exist and when it
 * exists but isn't owned by `wallet`, so ownership is never leaked via a
 * distinct error type/status.
 */
export async function getLpPositionById(
   lpId: string,
   wallet: string
): Promise<LpPositionSummary> {
   const position = await prisma.lpPosition.findUnique({ where: { lpId } });
   if (!position || position.wallet !== wallet) {
      throw new LpPositionNotFoundError(lpId);
   }
   return toSummary(position);
}

export interface LpPoolSummary {
   keyId: string;
   totalPoolSize: string;
   /**
    * Simplified APR estimate: recent accrued rewards across the pool,
    * annualized against pool size. This is NOT a precise on-chain yield
    * figure — it ignores compounding, time-weighting of individual
    * positions, and reward-rate changes over time. Treat as a rough
    * indicator only.
    */
   estimatedApr: number;
}

/** Total active pool size and a simplified APR estimate for a key. */
export async function getLpPoolSummary(keyId: string): Promise<LpPoolSummary> {
   const positions = await prisma.lpPosition.findMany({
      where: { keyId, status: 'active' },
   });

   const totalPoolSize = positions.reduce(
      (sum, p) => sum + Number(p.sharePercent),
      0
   );
   const totalRewards = positions.reduce(
      (sum, p) => sum + Number(p.accruedRewards),
      0
   );

   // Simplified placeholder: annualize accrued-to-date rewards against pool
   // size as if the current accrual rate held for a full year. Real APR
   // would need a time-windowed reward rate, not lifetime accrued rewards.
   const estimatedApr =
      totalPoolSize > 0 ? (totalRewards / totalPoolSize) * 100 : 0;

   return {
      keyId,
      totalPoolSize: String(totalPoolSize),
      estimatedApr,
   };
}
