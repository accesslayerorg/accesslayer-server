// src/modules/bounties/bounty.service.ts
// Bounty board read models, status computation, and management views (#1307).

import { prisma } from '../../utils/prisma.utils';

export type BountyStatus = 'open' | 'expired' | 'completed' | 'reclaimed';

export interface BountyRecord {
   id: string;
   onChainId: string;
   keyId: string;
   creatorHandle: string;
   creatorWallet: string;
   title: string;
   description: string | null;
   rewardAmount: bigint;
   awardedAmount: bigint;
   reclaimedAmount: bigint;
   maxWinners: number;
   winnersCount: number;
   deadlineLedger: number;
   reclaimedAtLedger: number | null;
   createdAt: Date;
}

export class BountyNotFoundError extends Error {
   constructor(id: string) {
      super(`Bounty not found: ${id}`);
      this.name = 'BountyNotFoundError';
   }
}

export function computeBountyStatus(
   bounty: Pick<
      BountyRecord,
      | 'reclaimedAtLedger'
      | 'reclaimedAmount'
      | 'winnersCount'
      | 'maxWinners'
      | 'awardedAmount'
      | 'rewardAmount'
      | 'deadlineLedger'
   >,
   currentLedger: number
): BountyStatus {
   if (bounty.reclaimedAtLedger !== null || bounty.reclaimedAmount > 0n) {
      return 'reclaimed';
   }
   if (
      bounty.winnersCount >= bounty.maxWinners ||
      bounty.awardedAmount >= bounty.rewardAmount
   ) {
      return 'completed';
   }
   if (currentLedger > bounty.deadlineLedger) {
      return 'expired';
   }
   return 'open';
}

export function computeReclaimableAmount(
   bounty: Pick<
      BountyRecord,
      | 'reclaimedAtLedger'
      | 'reclaimedAmount'
      | 'winnersCount'
      | 'maxWinners'
      | 'awardedAmount'
      | 'rewardAmount'
      | 'deadlineLedger'
   >,
   currentLedger: number
): bigint {
   const status = computeBountyStatus(bounty, currentLedger);
   if (status !== 'expired') return 0n;
   return bounty.rewardAmount > bounty.awardedAmount
      ? bounty.rewardAmount - bounty.awardedAmount
      : 0n;
}

async function getCurrentLedger(): Promise<number> {
   const latest = await prisma.ledgerCheckpoint.findFirst({
      orderBy: { ledger: 'desc' },
      select: { ledger: true },
   });
   return latest?.ledger ?? 0;
}

function serializeBountySummary(bounty: BountyRecord, currentLedger: number) {
   const status = computeBountyStatus(bounty, currentLedger);
   const winnersRemaining = Math.max(0, bounty.maxWinners - bounty.winnersCount);
   return {
      id: bounty.id,
      onChainId: bounty.onChainId,
      keyId: bounty.keyId,
      creatorHandle: bounty.creatorHandle,
      creatorWallet: bounty.creatorWallet,
      title: bounty.title,
      description: bounty.description,
      rewardAmount: bounty.rewardAmount.toString(),
      awardedAmount: bounty.awardedAmount.toString(),
      reclaimedAmount: bounty.reclaimedAmount.toString(),
      maxWinners: bounty.maxWinners,
      winnersCount: bounty.winnersCount,
      winnersRemaining,
      deadlineLedger: bounty.deadlineLedger,
      reclaimedAtLedger: bounty.reclaimedAtLedger,
      status,
      createdAt: bounty.createdAt.toISOString(),
   };
}

export class BountyService {
   async listBounties(params: {
      keyId?: string;
      status?: BountyStatus;
      minReward?: bigint;
      cursor?: string;
      limit?: number;
      currentLedger?: number;
   }) {
      const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
      const currentLedger = params.currentLedger ?? (await getCurrentLedger());

      const where: Record<string, unknown> = {};
      if (params.keyId) where.keyId = params.keyId;
      if (params.minReward !== undefined) {
         where.rewardAmount = { gte: params.minReward };
      }

      const rows = await prisma.bounty.findMany({
         where,
         orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
         ...(params.cursor
            ? { cursor: { id: params.cursor }, skip: 1 }
            : {}),
         take: params.status ? limit * 3 : limit + 1,
      });

      const mapped = rows
         .map(b => serializeBountySummary(b, currentLedger))
         .filter(b => (!params.status ? true : b.status === params.status));

      const hasMore = mapped.length > limit;
      const items = mapped.slice(0, limit);
      const nextCursor =
         hasMore && items.length > 0 ? items[items.length - 1].id : null;

      return { items, nextCursor, hasMore };
   }

   async getBountyDetail(id: string, currentLedgerOverride?: number) {
      const bounty = await prisma.bounty.findFirst({
         where: { OR: [{ id }, { onChainId: id }] },
         include: {
            submissions: { orderBy: { createdAt: 'asc' } },
            awards: { orderBy: { createdAt: 'asc' } },
         },
      });

      if (!bounty) {
         throw new BountyNotFoundError(id);
      }

      const currentLedger =
         currentLedgerOverride ?? (await getCurrentLedger());

      return {
         ...serializeBountySummary(bounty, currentLedger),
         submissions: bounty.submissions.map(s => ({
            id: s.id,
            submissionId: s.submissionId,
            submitter: s.submitter,
            contentUri: s.contentUri,
            ledger: s.ledger,
            txHash: s.txHash,
            createdAt: s.createdAt.toISOString(),
         })),
         awards: bounty.awards.map(a => ({
            id: a.id,
            submissionId: a.submissionId,
            winner: a.winner,
            amount: a.amount.toString(),
            ledger: a.ledger,
            txHash: a.txHash,
            createdAt: a.createdAt.toISOString(),
         })),
      };
   }

   async listCreatorBounties(handle: string, currentLedgerOverride?: number) {
      const currentLedger =
         currentLedgerOverride ?? (await getCurrentLedger());
      const bounties = await prisma.bounty.findMany({
         where: { creatorHandle: handle },
         orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });

      let totalReclaimable = 0n;
      const items = bounties.map(b => {
         const reclaimable = computeReclaimableAmount(b, currentLedger);
         totalReclaimable += reclaimable;
         return {
            ...serializeBountySummary(b, currentLedger),
            reclaimableAmount: reclaimable.toString(),
         };
      });

      return {
         creatorHandle: handle,
         totalReclaimableAmount: totalReclaimable.toString(),
         items,
      };
   }
}

export const bountyService = new BountyService();
