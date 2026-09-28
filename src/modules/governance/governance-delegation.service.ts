// src/modules/governance/governance-delegation.service.ts
// Read-model service for delegated governance voting (#933).
//
// All writes are performed by the indexer
// (governance-delegation-indexer.service.ts).  This module is read-only.
//
// Three query surfaces:
//   getCurrentDelegate    — who a wallet has delegated to (per key scope)
//   getActiveDelegators   — wallets that have delegated TO a given address
//   getDelegationHistory  — full event log for a wallet across all keys

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import { buildOffsetPaginationMeta } from '../../utils/pagination.utils';

// ── Cache TTLs ────────────────────────────────────────────────

const DELEGATE_CACHE_TTL_SECONDS = 60;
const DELEGATORS_CACHE_TTL_SECONDS = 60;
const HISTORY_CACHE_TTL_SECONDS = 60;

// ── Error classes ─────────────────────────────────────────────

export class DelegationNotFoundError extends Error {
   constructor(wallet: string, keyId?: string) {
      super(
         keyId
            ? `No active delegation found for wallet ${wallet} on key ${keyId}`
            : `No active delegation found for wallet ${wallet}`
      );
      this.name = 'DelegationNotFoundError';
   }
}

// ── Shared item shapes ────────────────────────────────────────

export interface DelegationItem {
   id: string;
   delegatorWallet: string;
   keyId: string;
   delegateeWallet: string;
   isActive: boolean;
   ledger: number;
   occurredAt: string;
   createdAt: string;
   updatedAt: string;
}

export interface DelegatorItem {
   id: string;
   delegatorWallet: string;
   keyId: string;
   ledger: number;
   occurredAt: string;
}

export interface DelegationHistoryItem {
   id: string;
   delegatorWallet: string;
   keyId: string;
   /** null for 'revoked' entries */
   delegateeWallet: string | null;
   action: 'set' | 'revoked';
   ledger: number;
   txHash: string;
   occurredAt: string;
}

// ── Cache invalidation helpers (used by indexer) ──────────────

export function delegateCachePattern(wallet: string): string {
   return `governance:delegation:delegate:${wallet}:*`;
}

export function delegatorsCachePattern(wallet: string): string {
   return `governance:delegation:delegators:${wallet}:*`;
}

export function delegationHistoryCachePattern(wallet: string): string {
   return `governance:delegation:history:${wallet}:*`;
}

// ── Current delegate ──────────────────────────────────────────

export interface GetCurrentDelegateQuery {
   /** Delegator wallet to look up. */
   wallet: string;
   /** Optional: narrow to a specific creator key. */
   keyId?: string;
}

export type CurrentDelegateResult =
   | { delegated: false }
   | { delegated: true; delegation: DelegationItem };

/**
 * Return the current active delegate for a wallet, optionally scoped to a
 * specific creator key.
 *
 * When `keyId` is omitted and the wallet has multiple active delegations
 * across different keys, the most-recently-set one is returned.  Callers
 * that need per-key precision should always supply `keyId`.
 *
 * Returns `{ delegated: false }` when no active delegation exists rather than
 * throwing, so the route can return a clean 200 with that shape.
 *
 * Cached per (wallet, keyId) for 60 s.
 */
export async function getCurrentDelegate(
   query: GetCurrentDelegateQuery
): Promise<CurrentDelegateResult> {
   const { wallet, keyId } = query;
   const cacheKey = `governance:delegation:delegate:${wallet}:${keyId ?? '_all'}`;
   const cached = await cacheGetJson<CurrentDelegateResult>(cacheKey);
   if (cached) return cached;

   const row = await prisma.voteDelegation.findFirst({
      where: {
         delegatorWallet: wallet,
         isActive: true,
         ...(keyId ? { keyId } : {}),
      },
      orderBy: { occurredAt: 'desc' },
   });

   const result: CurrentDelegateResult = row
      ? { delegated: true, delegation: mapDelegationRow(row) }
      : { delegated: false };

   await cacheSetJson(cacheKey, result, DELEGATE_CACHE_TTL_SECONDS);
   return result;
}

// ── Active delegators list ────────────────────────────────────

export interface GetActiveDelegatorsQuery {
   /** Delegatee wallet: return wallets that delegate TO this address. */
   wallet: string;
   /** Optional: narrow to a specific creator key. */
   keyId?: string;
   limit: number;
   offset: number;
}

export interface ActiveDelegatorsResult {
   items: DelegatorItem[];
   meta: ReturnType<typeof buildOffsetPaginationMeta>;
}

/**
 * Return all wallets that currently have an active delegation pointing to
 * `wallet`, sorted by delegation date descending.
 *
 * Optionally filtered by `keyId` to show delegators on a single key.
 *
 * Cached per (wallet, keyId, limit, offset) for 60 s.
 */
export async function getActiveDelegators(
   query: GetActiveDelegatorsQuery
): Promise<ActiveDelegatorsResult> {
   const { wallet, keyId, limit, offset } = query;
   const cacheKey = `governance:delegation:delegators:${wallet}:${keyId ?? '_all'}:${limit}:${offset}`;
   const cached = await cacheGetJson<ActiveDelegatorsResult>(cacheKey);
   if (cached) return cached;

   const where = {
      delegateeWallet: wallet,
      isActive: true,
      ...(keyId ? { keyId } : {}),
   };

   const [rows, total] = await Promise.all([
      prisma.voteDelegation.findMany({
         where,
         orderBy: { occurredAt: 'desc' },
         skip: offset,
         take: limit,
         select: {
            id: true,
            delegatorWallet: true,
            keyId: true,
            ledger: true,
            occurredAt: true,
         },
      }),
      prisma.voteDelegation.count({ where }),
   ]);

   const result: ActiveDelegatorsResult = {
      items: rows.map(r => ({
         id: r.id,
         delegatorWallet: r.delegatorWallet,
         keyId: r.keyId,
         ledger: r.ledger,
         occurredAt: r.occurredAt.toISOString(),
      })),
      meta: buildOffsetPaginationMeta({ limit, offset, total }),
   };

   await cacheSetJson(cacheKey, result, DELEGATORS_CACHE_TTL_SECONDS);
   return result;
}

// ── Delegation history ────────────────────────────────────────

export interface GetDelegationHistoryQuery {
   /** Wallet whose delegation history to return (as delegator OR delegatee). */
   wallet: string;
   /** Optional: narrow to a specific creator key. */
   keyId?: string;
   limit: number;
   offset: number;
}

export interface DelegationHistoryResult {
   items: DelegationHistoryItem[];
   meta: ReturnType<typeof buildOffsetPaginationMeta>;
}

/**
 * Return the full delegation event log for `wallet` (both sides: events where
 * the wallet was the delegator or the delegatee), newest first.
 *
 * Optionally filtered by `keyId`.
 *
 * Cached per (wallet, keyId, limit, offset) for 60 s.
 */
export async function getDelegationHistory(
   query: GetDelegationHistoryQuery
): Promise<DelegationHistoryResult> {
   const { wallet, keyId, limit, offset } = query;
   const cacheKey = `governance:delegation:history:${wallet}:${keyId ?? '_all'}:${limit}:${offset}`;
   const cached = await cacheGetJson<DelegationHistoryResult>(cacheKey);
   if (cached) return cached;

   const where = {
      OR: [
         { delegatorWallet: wallet },
         { delegateeWallet: wallet },
      ],
      ...(keyId ? { keyId } : {}),
   };

   const [rows, total] = await Promise.all([
      prisma.voteDelegationHistory.findMany({
         where,
         orderBy: { occurredAt: 'desc' },
         skip: offset,
         take: limit,
      }),
      prisma.voteDelegationHistory.count({ where }),
   ]);

   const result: DelegationHistoryResult = {
      items: rows.map(mapHistoryRow),
      meta: buildOffsetPaginationMeta({ limit, offset, total }),
   };

   await cacheSetJson(cacheKey, result, HISTORY_CACHE_TTL_SECONDS);
   return result;
}

// ── Vote-weight helper (used by castKeyProposalVote) ──────────

/**
 * Return the sum of `KeyOwnership.balance` for every wallet that currently
 * has an active delegation pointing to `delegateeWallet` on `keyId`.
 *
 * This is the delegated weight that the delegatee carries in addition to
 * their own balance when casting a governance vote.
 *
 * Not cached — called inside a vote transaction where freshness is critical.
 */
export async function getDelegatedVoteWeight(
   delegateeWallet: string,
   keyId: string
): Promise<number> {
   // Fetch all active delegator wallets for this delegatee+key combination.
   const activeDelegations = await prisma.voteDelegation.findMany({
      where: { delegateeWallet, keyId, isActive: true },
      select: { delegatorWallet: true },
   });

   if (activeDelegations.length === 0) return 0;

   const delegatorAddresses = activeDelegations.map(d => d.delegatorWallet);

   // Sum the key balances of all delegators.
   const agg = await prisma.keyOwnership.aggregate({
      where: {
         ownerAddress: { in: delegatorAddresses },
         creatorId: keyId,
         balance: { gt: 0 },
      },
      _sum: { balance: true },
   });

   return Number(agg._sum.balance ?? 0);
}

// ── Row mappers ───────────────────────────────────────────────

function mapDelegationRow(row: {
   id: string;
   delegatorWallet: string;
   keyId: string;
   delegateeWallet: string;
   isActive: boolean;
   ledger: number;
   occurredAt: Date;
   createdAt: Date;
   updatedAt: Date;
}): DelegationItem {
   return {
      id: row.id,
      delegatorWallet: row.delegatorWallet,
      keyId: row.keyId,
      delegateeWallet: row.delegateeWallet,
      isActive: row.isActive,
      ledger: row.ledger,
      occurredAt: row.occurredAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
   };
}

function mapHistoryRow(row: {
   id: string;
   delegatorWallet: string;
   keyId: string;
   delegateeWallet: string | null;
   action: string;
   ledger: number;
   txHash: string;
   occurredAt: Date;
}): DelegationHistoryItem {
   return {
      id: row.id,
      delegatorWallet: row.delegatorWallet,
      keyId: row.keyId,
      delegateeWallet: row.delegateeWallet,
      action: row.action as 'set' | 'revoked',
      ledger: row.ledger,
      txHash: row.txHash,
      occurredAt: row.occurredAt.toISOString(),
   };
}
