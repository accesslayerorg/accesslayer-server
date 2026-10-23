// src/modules/treasury/treasury.service.ts
// Read side of the platform treasury (#1181). Amounts are returned as strings
// in the contract's smallest unit (stroops) to avoid precision loss.
//
// total_balance      = sum of gross fee inflows - sum of allocations
// per_source_breakdown = gross fee inflow per source (allocations are not
//                        attributed to a source on-chain)

import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheInvalidate,
   cacheSetJson,
} from '../../utils/redis.utils';
import { buildPaginationMetadata } from '../../utils/indexer-event-fields.utils';
import { PaginationMetadata } from '../../utils/api-response.utils';

export const TREASURY_CACHE_TTL_SECONDS = 60;
/** Every treasury cache key lives under this prefix so one pattern clears them. */
export const TREASURY_CACHE_PATTERN = 'treasury:*';
const SUMMARY_CACHE_KEY = 'treasury:summary';

export interface TreasurySummary {
   total_balance: string;
   per_source_breakdown: Array<{ source: string; balance: string }>;
   last_updated: string | null;
}

export interface TreasuryAllocationView {
   destination: string;
   amount: string;
   purpose: string;
   tx_hash: string;
   ledger: number;
   occurred_at: string;
}

export interface TreasuryInflowView {
   source: string;
   amount: string;
   tx_hash: string;
   ledger: number;
   occurred_at: string;
}

export interface TreasuryPage<T> {
   data: T[];
   meta: PaginationMetadata;
}

export interface TreasuryPageParams {
   page: number;
   limit: number;
}

/** Clears every cached treasury read. Called after any treasury event. */
export async function invalidateTreasuryCache(): Promise<void> {
   await cacheInvalidate(TREASURY_CACHE_PATTERN);
}

export async function getTreasurySummary(): Promise<TreasurySummary> {
   const cached = await cacheGetJson<TreasurySummary>(SUMMARY_CACHE_KEY);
   if (cached) return cached;

   const [balances, allocated] = await Promise.all([
      prisma.treasuryBalance.findMany({ orderBy: { source: 'asc' } }),
      prisma.treasuryAllocation.aggregate({ _sum: { amount: true } }),
   ]);

   const collected = balances.reduce(
      (sum, row) => sum + BigInt(row.balance.toFixed(0)),
      0n
   );
   const spent = BigInt(allocated._sum.amount?.toFixed(0) ?? '0');
   const lastUpdated = balances.reduce<Date | null>(
      (latest, row) => (!latest || row.updatedAt > latest ? row.updatedAt : latest),
      null
   );

   const summary: TreasurySummary = {
      total_balance: (collected - spent).toString(),
      per_source_breakdown: balances.map(row => ({
         source: row.source,
         balance: row.balance.toFixed(0),
      })),
      last_updated: lastUpdated?.toISOString() ?? null,
   };
   await cacheSetJson(SUMMARY_CACHE_KEY, summary, TREASURY_CACHE_TTL_SECONDS);
   return summary;
}

export async function listTreasuryAllocations(
   params: TreasuryPageParams
): Promise<TreasuryPage<TreasuryAllocationView>> {
   const cacheKey = `treasury:allocations:${params.page}:${params.limit}`;
   const cached = await cacheGetJson<TreasuryPage<TreasuryAllocationView>>(cacheKey);
   if (cached) return cached;

   const [rows, totalCount] = await prisma.$transaction([
      prisma.treasuryAllocation.findMany({
         orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
         skip: (params.page - 1) * params.limit,
         take: params.limit,
      }),
      prisma.treasuryAllocation.count(),
   ]);

   const page: TreasuryPage<TreasuryAllocationView> = {
      data: rows.map(row => ({
         destination: row.destination,
         amount: row.amount.toFixed(0),
         purpose: row.purpose,
         tx_hash: row.txHash,
         ledger: row.ledger,
         occurred_at: row.occurredAt.toISOString(),
      })),
      meta: buildPaginationMetadata({ ...params, totalCount }),
   };
   await cacheSetJson(cacheKey, page, TREASURY_CACHE_TTL_SECONDS);
   return page;
}

export async function listTreasuryInflows(
   params: TreasuryPageParams
): Promise<TreasuryPage<TreasuryInflowView>> {
   const cacheKey = `treasury:inflows:${params.page}:${params.limit}`;
   const cached = await cacheGetJson<TreasuryPage<TreasuryInflowView>>(cacheKey);
   if (cached) return cached;

   const [rows, totalCount] = await prisma.$transaction([
      prisma.treasuryInflow.findMany({
         orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
         skip: (params.page - 1) * params.limit,
         take: params.limit,
      }),
      prisma.treasuryInflow.count(),
   ]);

   const page: TreasuryPage<TreasuryInflowView> = {
      data: rows.map(row => ({
         source: row.source,
         amount: row.amount.toFixed(0),
         tx_hash: row.txHash,
         ledger: row.ledger,
         occurred_at: row.occurredAt.toISOString(),
      })),
      meta: buildPaginationMetadata({ ...params, totalCount }),
   };
   await cacheSetJson(cacheKey, page, TREASURY_CACHE_TTL_SECONDS);
   return page;
}
