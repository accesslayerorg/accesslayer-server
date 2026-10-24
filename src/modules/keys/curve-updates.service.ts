import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';

export const CURVE_UPDATE_CACHE_TTL_SECONDS = 60;
export const curveUpdateCacheKeys = {
   pending: (keyId: string) => `keys:curve-updates:${keyId}:pending`,
   history: (keyId: string) => `keys:curve-updates:${keyId}:history`,
};

type CurveUpdateRow = {
   proposalId: string;
   status: string;
   proposedParams: unknown;
   eta: Date;
   proposedAt: Date;
   completedAt: Date | null;
   outcome: string | null;
};

function serialize(row: CurveUpdateRow, now: Date) {
   return {
      proposal_id: row.proposalId,
      status: row.status,
      proposed_params: row.proposedParams,
      eta: row.eta.toISOString(),
      eta_seconds_remaining: Math.max(
         0,
         Math.ceil((row.eta.getTime() - now.getTime()) / 1000)
      ),
      proposed_at: row.proposedAt.toISOString(),
      completed_at: row.completedAt?.toISOString() ?? null,
      outcome: row.outcome,
   };
}

export async function getPendingCurveUpdates(keyId: string, now = new Date()) {
   const cacheKey = curveUpdateCacheKeys.pending(keyId);
   // Cache stable DB fields only. Countdown is deliberately recomputed below.
   let rows = await cacheGetJson<CurveUpdateRow[]>(cacheKey);
   if (!rows) {
      rows = (await prisma.curveUpdate.findMany({
         where: { keyId, status: 'pending' },
         orderBy: [{ eta: 'asc' }, { proposedAt: 'asc' }],
         select: {
            proposalId: true,
            status: true,
            proposedParams: true,
            eta: true,
            proposedAt: true,
            completedAt: true,
            outcome: true,
         },
      })) as CurveUpdateRow[];
      await cacheSetJson(cacheKey, rows, CURVE_UPDATE_CACHE_TTL_SECONDS);
   }
   return rows.map(row =>
      serialize(
         {
            ...row,
            eta: new Date(row.eta),
            proposedAt: new Date(row.proposedAt),
            completedAt: row.completedAt ? new Date(row.completedAt) : null,
         },
         now
      )
   );
}

export async function getCurveUpdateHistory(keyId: string) {
   const cacheKey = curveUpdateCacheKeys.history(keyId);
   const cached = await cacheGetJson<ReturnType<typeof serialize>[]>(cacheKey);
   if (cached) return cached;
   const rows = (await prisma.curveUpdate.findMany({
      where: { keyId, status: { in: ['completed', 'cancelled'] } },
      orderBy: { completedAt: 'desc' },
      select: {
         proposalId: true,
         status: true,
         proposedParams: true,
         eta: true,
         proposedAt: true,
         completedAt: true,
         outcome: true,
      },
   })) as CurveUpdateRow[];
   const result = rows.map(row => serialize(row, new Date()));
   await cacheSetJson(cacheKey, result, CURVE_UPDATE_CACHE_TTL_SECONDS);
   return result;
}
