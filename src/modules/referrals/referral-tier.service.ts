// src/modules/referrals/referral-tier.service.ts
// Referral tier state, upgrade history and persistence (#1034).
//
// The current tier is derived from on-chain `ReferralTierUpgraded` events
// (persisted in `ReferralTier` + `ReferralTierEvent`). Threshold and
// reward-rate metadata come from the tier ladder in
// `referral-tier.constants.ts`.

import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheInvalidate,
   cacheSetJson,
} from '../../utils/redis.utils';
import {
   CursorChecksumError,
   decodeCursor,
   encodeCursor,
} from '../../utils/cursor.utils';
import {
   buildReferralTierCacheKey,
   getNextReferralTier,
   getReferralTierDefinition,
   REFERRAL_TIER_CACHE_TTL_SECONDS,
} from './referral-tier.constants';
import {
   ReferralTierCursorPayload,
   ReferralTierHistoryItem,
   ReferralTierHistoryPage,
   ReferralTierSnapshot,
} from './referral-tier.schemas';

/** Fields supplied by the indexer when an upgrade is observed on-chain. */
export interface ReferralTierUpgradeInput {
   walletAddress: string;
   previousTier: number;
   newTier: number;
   cumulativeVolume: number;
   txHash: string;
   eventIndex: number;
   ledger: number;
   occurredAt: Date;
}

export interface ReferralTierHistoryQueryInput {
   limit: number;
   cursor?: string;
}

/**
 * Assemble the API-facing tier snapshot from a persisted tier + volume,
 * filling in the next threshold, distance-to-next and reward rate.
 */
export function buildReferralTierSnapshot(
   wallet: string,
   tier: number,
   cumulativeVolume: number,
   updatedAt: Date | null
): ReferralTierSnapshot {
   const definition = getReferralTierDefinition(tier);
   const next = getNextReferralTier(definition.tier);

   return {
      wallet,
      tier: definition.tier,
      cumulativeVolume,
      nextThreshold: next ? next.minVolume : null,
      distanceToNextThreshold: next
         ? Math.max(0, next.minVolume - cumulativeVolume)
         : null,
      rewardRateBps: definition.rewardRateBps,
      updatedAt: updatedAt ? updatedAt.toISOString() : null,
   };
}

/**
 * Current tier snapshot for a wallet, cached in Redis for 5 minutes. Wallets
 * with no indexed upgrades default to the entry tier with zero volume.
 */
export async function getReferralTierSnapshot(
   wallet: string
): Promise<ReferralTierSnapshot> {
   const cacheKey = buildReferralTierCacheKey(wallet);
   const cached = await cacheGetJson<ReferralTierSnapshot>(cacheKey);
   if (cached) {
      return cached;
   }

   const record = await prisma.referralTier.findUnique({
      where: { walletAddress: wallet },
   });

   const snapshot = buildReferralTierSnapshot(
      wallet,
      record?.tier ?? 1,
      record ? Number(record.cumulativeVolume) : 0,
      record?.lastUpgradedAt ?? null
   );

   await cacheSetJson(cacheKey, snapshot, REFERRAL_TIER_CACHE_TTL_SECONDS);
   return snapshot;
}

/**
 * Persist a single `ReferralTierUpgraded` event.
 *
 * - The upgrade is written to the history log via an idempotent upsert on
 *   `(txHash, eventIndex)`, so replays never create duplicate rows.
 * - The current tier state only ever advances (max tier / max volume), so an
 *   out-of-order replay of an older upgrade cannot downgrade a wallet.
 * - The wallet's cached snapshot is invalidated so the next read is fresh.
 */
export async function recordReferralTierUpgrade(
   input: ReferralTierUpgradeInput
): Promise<void> {
   await prisma.referralTierEvent.upsert({
      where: {
         txHash_eventIndex: {
            txHash: input.txHash,
            eventIndex: input.eventIndex,
         },
      },
      create: {
         walletAddress: input.walletAddress,
         previousTier: input.previousTier,
         newTier: input.newTier,
         cumulativeVolume: input.cumulativeVolume,
         ledger: input.ledger,
         txHash: input.txHash,
         eventIndex: input.eventIndex,
         occurredAt: input.occurredAt,
      },
      update: {},
   });

   const existing = await prisma.referralTier.findUnique({
      where: { walletAddress: input.walletAddress },
   });

   if (!existing) {
      await prisma.referralTier.create({
         data: {
            walletAddress: input.walletAddress,
            tier: input.newTier,
            cumulativeVolume: input.cumulativeVolume,
            lastUpgradedAt: input.occurredAt,
         },
      });
   } else {
      const nextTier = Math.max(existing.tier, input.newTier);
      const nextVolume = Math.max(
         Number(existing.cumulativeVolume),
         input.cumulativeVolume
      );

      if (
         nextTier !== existing.tier ||
         nextVolume !== Number(existing.cumulativeVolume)
      ) {
         await prisma.referralTier.update({
            where: { walletAddress: input.walletAddress },
            data: {
               tier: nextTier,
               cumulativeVolume: nextVolume,
               lastUpgradedAt: input.occurredAt,
            },
         });
      }
   }

   await cacheInvalidate(buildReferralTierCacheKey(input.walletAddress));
}

/**
 * Cursor-paginated tier upgrade history for a wallet, newest first. The
 * cursor encodes `(occurredAt, id)` for stable keyset pagination.
 */
export async function getReferralTierHistory(
   wallet: string,
   query: ReferralTierHistoryQueryInput
): Promise<ReferralTierHistoryPage> {
   const cursorPayload = parseReferralTierCursor(query.cursor);

   const where: Prisma.ReferralTierEventWhereInput = {
      walletAddress: wallet,
   };
   if (cursorPayload) {
      where.AND = [
         {
            OR: [
               { occurredAt: { lt: new Date(cursorPayload.occurredAt) } },
               {
                  occurredAt: new Date(cursorPayload.occurredAt),
                  id: { lt: cursorPayload.id },
               },
            ],
         },
      ];
   }

   const rows = await prisma.referralTierEvent.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
   });

   const hasMore = rows.length > query.limit;
   const page = rows.slice(0, query.limit);
   const last = page.at(-1);

   const items: ReferralTierHistoryItem[] = page.map(row => ({
      id: row.id,
      previousTier: row.previousTier,
      newTier: row.newTier,
      cumulativeVolume: Number(row.cumulativeVolume),
      occurredAt: row.occurredAt.toISOString(),
      txHash: row.txHash,
   }));

   return {
      items,
      pagination: {
         limit: query.limit,
         hasMore,
         nextCursor:
            hasMore && last
               ? encodeCursor<ReferralTierCursorPayload>({
                    occurredAt: last.occurredAt.toISOString(),
                    id: last.id,
                 })
               : undefined,
      },
   };
}

function parseReferralTierCursor(
   cursor: string | undefined
): ReferralTierCursorPayload | null {
   if (!cursor) return null;
   try {
      return decodeCursor<ReferralTierCursorPayload>(cursor);
   } catch (error) {
      if (error instanceof CursorChecksumError) {
         throw error;
      }
      throw new CursorChecksumError('Invalid cursor');
   }
}
