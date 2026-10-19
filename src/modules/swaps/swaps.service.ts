// src/modules/swaps/swaps.service.ts
// Service layer for atomic swap proposals querying and formatting (#1087)

import { prisma } from '../../utils/prisma.utils';
import {
   buildOffsetPaginationMeta,
   buildPaginationMeta,
} from '../../utils/pagination.utils';
import { markExpiredSwaps } from '../indexer/atomic-swap-indexer.service';
import {
   AtomicSwapStatus,
   FormattedAtomicSwap,
   PaginatedSwapsResponse,
   SwapPaginationMeta,
} from './swaps.types';
import { SwapsQuery } from './swaps.schemas';

/**
 * Normalizes and formats a raw database atomic_swaps record.
 * Calculates live expiry countdown in seconds and derives status.
 */
export function formatSwapRecord(
   row: any,
   now: Date = new Date()
): FormattedAtomicSwap {
   const nowMs = now.getTime();
   const expiresAt =
      row.expiresAt instanceof Date ? row.expiresAt : new Date(row.expiresAt);
   const proposedAt =
      row.proposedAt instanceof Date
         ? row.proposedAt
         : row.proposedAt
           ? new Date(row.proposedAt)
           : new Date();
   const executedAt = row.executedAt
      ? row.executedAt instanceof Date
         ? row.executedAt
         : new Date(row.executedAt)
      : null;
   const cancelledAt = row.cancelledAt
      ? row.cancelledAt instanceof Date
         ? row.cancelledAt
         : new Date(row.cancelledAt)
      : null;
   const createdAt = row.createdAt
      ? row.createdAt instanceof Date
         ? row.createdAt
         : new Date(row.createdAt)
      : proposedAt;
   const updatedAt = row.updatedAt
      ? row.updatedAt instanceof Date
         ? row.updatedAt
         : new Date(row.updatedAt)
      : createdAt;

   const expiresAtMs = expiresAt.getTime();
   const isTimeExpired = !isNaN(expiresAtMs) && expiresAtMs <= nowMs;
   const rawStatus = String(row.status || 'pending').toLowerCase();

   let status: AtomicSwapStatus;
   if (rawStatus === 'executed') {
      status = 'executed';
   } else if (rawStatus === 'cancelled') {
      status = 'cancelled';
   } else if (rawStatus === 'expired' || isTimeExpired) {
      status = 'expired';
   } else {
      status = 'pending';
   }

   const expiryCountdown =
      status === 'pending'
         ? Math.max(0, Math.floor((expiresAtMs - nowMs) / 1000))
         : 0;

   const isExpired = status === 'expired' || isTimeExpired;

   const swapId = String(row.swapId ?? row.swap_id ?? row.id);
   const proposer = String(
      row.proposer ?? row.proposerWallet ?? row.proposer_wallet ?? ''
   );
   const counterparty = String(
      row.counterparty ??
         row.counterpartyWallet ??
         row.counterparty_wallet ??
         ''
   );
   const offeredKey = String(row.offeredKey ?? row.offered_key ?? '');
   const offeredAmount = String(row.offeredAmount ?? row.offered_amount ?? '0');
   const requestedKey = String(row.requestedKey ?? row.requested_key ?? '');
   const requestedAmount = String(
      row.requestedAmount ?? row.requested_amount ?? '0'
   );
   const ledger =
      typeof row.ledger === 'number' ? row.ledger : Number(row.ledger) || 0;
   const txHash = String(row.txHash ?? row.tx_hash ?? '');

   return {
      id: String(row.id ?? swapId),
      swapId,
      swap_id: swapId,
      proposer,
      proposerWallet: proposer,
      proposer_wallet: proposer,
      counterparty,
      counterpartyWallet: counterparty,
      counterparty_wallet: counterparty,
      offeredKey,
      offered_key: offeredKey,
      offeredAmount,
      offered_amount: offeredAmount,
      requestedKey,
      requested_key: requestedKey,
      requestedAmount,
      requested_amount: requestedAmount,
      offered: {
         key: offeredKey,
         amount: offeredAmount,
      },
      requested: {
         key: requestedKey,
         amount: requestedAmount,
      },
      status,
      expiresAt,
      expires_at: expiresAt,
      expiryCountdown,
      expiry_countdown: expiryCountdown,
      isExpired,
      is_expired: isExpired,
      proposedAt,
      proposed_at: proposedAt,
      executedAt,
      executed_at: executedAt,
      cancelledAt,
      cancelled_at: cancelledAt,
      ledger,
      txHash,
      tx_hash: txHash,
      createdAt,
      created_at: createdAt,
      updatedAt,
      updated_at: updatedAt,
   };
}

/**
 * Builds a paginated envelope supporting both .items, .meta, .total, and numeric indexing.
 */
function buildEnvelope(
   items: FormattedAtomicSwap[],
   total: number,
   page: number,
   limit: number,
   offset: number
): PaginatedSwapsResponse {
   const pageMeta = buildPaginationMeta({
      page,
      pageSize: limit,
      totalItems: total,
   });

   const offsetMeta = buildOffsetPaginationMeta({
      limit,
      offset,
      total,
   });

   const meta: SwapPaginationMeta = {
      ...pageMeta,
      ...offsetMeta,
      totalCount: total,
      hasPrevPage: pageMeta.hasPreviousPage,
      hasPreviousPage: pageMeta.hasPreviousPage,
      hasMore: offsetMeta.hasMore,
      has_more: offsetMeta.hasMore,
   };

   const envelope: PaginatedSwapsResponse = {
      items,
      total,
      totalCount: total,
      meta,
      hasMore: offsetMeta.hasMore,
      has_more: offsetMeta.hasMore,
      length: items.length,
   };

   for (let i = 0; i < items.length; i++) {
      envelope[i] = items[i];
   }

   return envelope;
}

/**
 * GET /swaps/:wallet/outgoing
 *
 * Paginated outgoing proposals for a proposer wallet with status and expiry countdown (#1087).
 */
export async function fetchOutgoingSwaps(
   wallet: string,
   query: SwapsQuery,
   db: any = prisma
): Promise<PaginatedSwapsResponse> {
   const now = new Date();
   // Automatically mark expired proposals
   await markExpiredSwaps(db, now);

   const safeWallet = wallet.trim();
   const page = query.page ?? 1;
   const limit = query.limit ?? 20;
   const offset =
      query.offset && query.offset > 0 ? query.offset : (page - 1) * limit;

   const where: any = {
      proposer: safeWallet,
   };

   if (query.status && query.status.toLowerCase() !== 'all') {
      where.status = query.status.toLowerCase();
   }

   const [rows, total] = await Promise.all([
      db.atomicSwap.findMany({
         where,
         orderBy: [{ proposedAt: 'desc' }, { ledger: 'desc' }, { id: 'desc' }],
         skip: offset,
         take: limit,
      }),
      db.atomicSwap.count({ where }),
   ]);

   const items = rows.map((r: any) => formatSwapRecord(r, now));
   return buildEnvelope(items, total, page, limit, offset);
}

/**
 * GET /swaps/:wallet/incoming
 *
 * Paginated incoming proposals for counterparty wallet awaiting acceptance (#1087).
 */
export async function fetchIncomingSwaps(
   wallet: string,
   query: SwapsQuery,
   db: any = prisma
): Promise<PaginatedSwapsResponse> {
   const now = new Date();
   // Automatically mark expired proposals
   await markExpiredSwaps(db, now);

   const safeWallet = wallet.trim();
   const page = query.page ?? 1;
   const limit = query.limit ?? 20;
   const offset =
      query.offset && query.offset > 0 ? query.offset : (page - 1) * limit;

   const where: any = {
      counterparty: safeWallet,
   };

   if (query.status && query.status.toLowerCase() !== 'all') {
      where.status = query.status.toLowerCase();
   } else if (!query.status) {
      // By default: awaiting acceptance (pending and not yet expired)
      where.status = 'pending';
      where.expiresAt = {
         gt: now,
      };
   }

   const [rows, total] = await Promise.all([
      db.atomicSwap.findMany({
         where,
         orderBy: [{ proposedAt: 'desc' }, { ledger: 'desc' }, { id: 'desc' }],
         skip: offset,
         take: limit,
      }),
      db.atomicSwap.count({ where }),
   ]);

   const items = rows.map((r: any) => formatSwapRecord(r, now));
   return buildEnvelope(items, total, page, limit, offset);
}

/**
 * GET /swaps/:swap_id
 *
 * Single swap proposal detail with accurate offered/requested key and amount data (#1087).
 */
export async function fetchSwapById(
   swapId: string,
   db: any = prisma
): Promise<FormattedAtomicSwap | null> {
   const safeId = swapId.trim();
   const now = new Date();

   let row = await db.atomicSwap.findUnique({
      where: { swapId: safeId },
   });

   if (!row) {
      row = await db.atomicSwap.findFirst({
         where: {
            OR: [{ swapId: safeId }, { id: safeId }],
         },
      });
   }

   if (!row) {
      return null;
   }

   // If pending but past expiry, update DB record lazily
   const expiresAtMs = new Date(row.expiresAt).getTime();
   if (row.status === 'pending' && expiresAtMs <= now.getTime()) {
      try {
         row = await db.atomicSwap.update({
            where: { id: row.id },
            data: { status: 'expired' },
         });
      } catch {
         row.status = 'expired';
      }
   }

   return formatSwapRecord(row, now);
}
