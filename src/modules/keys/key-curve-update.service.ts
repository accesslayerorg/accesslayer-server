// src/modules/keys/key-curve-update.service.ts
//
// Key curve update timelock pending proposals and history service (#1113).

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';

export const CURVE_UPDATE_CACHE_TTL_SECONDS = 60;

export interface PendingCurveProposalResponse {
   proposal_id: string;
   proposalId?: string;
   key_id: string;
   keyId?: string;
   status: string;
   proposed_params: any;
   proposedParams?: any;
   eta: string | null;
   eta_countdown: number | null;
   etaCountdown?: number | null;
   eta_countdown_seconds: number | null;
   proposer: string | null;
   ledger: number;
   tx_hash: string;
   created_at: string;
}

export interface CurveUpdateHistoryItem {
   proposal_id: string;
   proposalId?: string;
   key_id: string;
   keyId?: string;
   status: string;
   outcome: string | null;
   proposed_params: any;
   proposedParams?: any;
   eta: string | null;
   proposer: string | null;
   executor: string | null;
   executed_at: string | null;
   ledger: number;
   tx_hash: string;
   created_at: string;
   updated_at: string;
}

/**
 * Returns pending bonding curve parameter update proposals for a key.
 *
 * `eta_countdown` is computed dynamically at request time from the stored ETA.
 * Cached for 60 seconds; dynamically recalculates countdown on cache hit.
 */
export async function getPendingCurveUpdates(
   keyId: string
): Promise<PendingCurveProposalResponse[]> {
   const cacheKey = `key:curve-updates:pending:${keyId}`;
   const cached = await cacheGetJson<PendingCurveProposalResponse[]>(cacheKey);
   if (cached !== null) {
      const now = Date.now();
      return cached.map(p => {
         let countdown: number | null = null;
         if (p.eta) {
            const diffMs = new Date(p.eta).getTime() - now;
            countdown = Math.max(0, Math.floor(diffMs / 1000));
         }
         return {
            ...p,
            eta_countdown: countdown,
            etaCountdown: countdown,
            eta_countdown_seconds: countdown,
         };
      });
   }

   const records = await prisma.curveUpdate.findMany({
      where: { keyId, status: 'pending' },
      orderBy: [{ eta: 'asc' }, { createdAt: 'asc' }],
   });

   const now = Date.now();
   const result: PendingCurveProposalResponse[] = records.map(r => {
      let countdown: number | null = null;
      if (r.eta) {
         const diffMs = r.eta.getTime() - now;
         countdown = Math.max(0, Math.floor(diffMs / 1000));
      }
      const isoEta = r.eta ? r.eta.toISOString() : null;
      return {
         proposal_id: r.proposalId,
         proposalId: r.proposalId,
         key_id: r.keyId,
         keyId: r.keyId,
         status: r.status,
         proposed_params: r.proposedParams,
         proposedParams: r.proposedParams,
         eta: isoEta,
         eta_countdown: countdown,
         etaCountdown: countdown,
         eta_countdown_seconds: countdown,
         proposer: r.proposer,
         ledger: r.ledger,
         tx_hash: r.txHash,
         created_at: r.createdAt.toISOString(),
      };
   });

   await cacheSetJson(cacheKey, result, CURVE_UPDATE_CACHE_TTL_SECONDS);
   return result;
}

/**
 * Returns completed and cancelled bonding curve parameter updates with outcomes for a key.
 *
 * Cached for 60 seconds; invalidated immediately when a new event arrives for the key.
 */
export async function getCurveUpdateHistory(
   keyId: string
): Promise<CurveUpdateHistoryItem[]> {
   const cacheKey = `key:curve-updates:history:${keyId}`;
   const cached = await cacheGetJson<CurveUpdateHistoryItem[]>(cacheKey);
   if (cached !== null) {
      return cached;
   }

   const records = await prisma.curveUpdate.findMany({
      where: {
         keyId,
         status: { in: ['completed', 'cancelled'] },
      },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
   });

   const result: CurveUpdateHistoryItem[] = records.map(r => ({
      proposal_id: r.proposalId,
      proposalId: r.proposalId,
      key_id: r.keyId,
      keyId: r.keyId,
      status: r.status,
      outcome: r.outcome,
      proposed_params: r.proposedParams,
      proposedParams: r.proposedParams,
      eta: r.eta ? r.eta.toISOString() : null,
      proposer: r.proposer,
      executor: r.executor,
      executed_at: r.executedAt ? r.executedAt.toISOString() : null,
      ledger: r.ledger,
      tx_hash: r.txHash,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
   }));

   await cacheSetJson(cacheKey, result, CURVE_UPDATE_CACHE_TTL_SECONDS);
   return result;
}
