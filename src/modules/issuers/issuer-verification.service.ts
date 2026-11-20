// src/modules/issuers/issuer-verification.service.ts
// Verification badge status for issuers (#1179).
//
// An issuer is verified when the latest event is a grant and the grant has not
// expired. A grant with no expiry never expires. A revoked or expired issuer
// reports is_verified: false with tier: null.

import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheInvalidate,
   cacheSetJson,
} from '../../utils/redis.utils';
import { buildPaginationMetadata } from '../../utils/indexer-event-fields.utils';
import { PaginationMetadata } from '../../utils/api-response.utils';

export const VERIFICATION_CACHE_TTL_SECONDS = 60;
const VERIFIED_LIST_CACHE_PATTERN = 'issuers:verified:*';
const DAY_MS = 86_400_000;

export interface IssuerVerificationStatus {
   wallet: string;
   is_verified: boolean;
   tier: string | null;
   expiry_timestamp: string | null;
   days_remaining: number | null;
}

export interface VerifiedIssuerView {
   wallet: string;
   tier: string | null;
   expiry_timestamp: string | null;
   days_remaining: number | null;
}

export interface VerificationRecord {
   isVerified: boolean;
   tier: string | null;
   expiresAt: Date | null;
}

export function verificationCacheKey(wallet: string): string {
   return `issuers:verification:${wallet}`;
}

/** Clears the cached status for one wallet and every cached verified-list page. */
export async function invalidateIssuerVerificationCache(
   wallet: string
): Promise<void> {
   await cacheInvalidate(verificationCacheKey(wallet), VERIFIED_LIST_CACHE_PATTERN);
}

/** Pure status derivation from the stored record, relative to `now`. */
export function toVerificationStatus(
   wallet: string,
   record: VerificationRecord | null,
   now: Date = new Date()
): IssuerVerificationStatus {
   const expiresAt = record?.expiresAt ?? null;
   const expired = expiresAt !== null && expiresAt.getTime() <= now.getTime();
   const active = Boolean(record?.isVerified) && !expired;

   if (!active) {
      return {
         wallet,
         is_verified: false,
         tier: null,
         expiry_timestamp: expiresAt?.toISOString() ?? null,
         days_remaining: expired ? 0 : null,
      };
   }

   return {
      wallet,
      is_verified: true,
      tier: record?.tier ?? null,
      expiry_timestamp: expiresAt?.toISOString() ?? null,
      days_remaining: expiresAt
         ? Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS)
         : null,
   };
}

export async function getIssuerVerificationStatus(
   wallet: string
): Promise<IssuerVerificationStatus> {
   const cacheKey = verificationCacheKey(wallet);
   const cached = await cacheGetJson<IssuerVerificationStatus>(cacheKey);
   if (cached) return cached;

   const record = await prisma.issuerVerification.findUnique({
      where: { wallet },
      select: { isVerified: true, tier: true, expiresAt: true },
   });
   const status = toVerificationStatus(wallet, record);
   await cacheSetJson(cacheKey, status, VERIFICATION_CACHE_TTL_SECONDS);
   return status;
}

export async function listVerifiedIssuers(params: {
   page: number;
   limit: number;
}): Promise<{ data: VerifiedIssuerView[]; meta: PaginationMetadata }> {
   const cacheKey = `issuers:verified:${params.page}:${params.limit}`;
   const cached = await cacheGetJson<{
      data: VerifiedIssuerView[];
      meta: PaginationMetadata;
   }>(cacheKey);
   if (cached) return cached;

   const now = new Date();
   const where = {
      isVerified: true,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
   };
   const [rows, totalCount] = await prisma.$transaction([
      prisma.issuerVerification.findMany({
         where,
         orderBy: { wallet: 'asc' },
         skip: (params.page - 1) * params.limit,
         take: params.limit,
         select: { wallet: true, tier: true, expiresAt: true },
      }),
      prisma.issuerVerification.count({ where }),
   ]);

   const result = {
      data: rows.map(row => {
         const status = toVerificationStatus(
            row.wallet,
            { isVerified: true, tier: row.tier, expiresAt: row.expiresAt },
            now
         );
         return {
            wallet: row.wallet,
            tier: status.tier,
            expiry_timestamp: status.expiry_timestamp,
            days_remaining: status.days_remaining,
         };
      }),
      meta: buildPaginationMetadata({ ...params, totalCount }),
   };
   await cacheSetJson(cacheKey, result, VERIFICATION_CACHE_TTL_SECONDS);
   return result;
}
