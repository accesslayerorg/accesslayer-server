// src/modules/users/holdings.service.ts
// Portfolio holdings for a wallet, enriched with lockup countdown data.
//
// currentPrice resolution order (no price oracle exists yet):
//   1. price on the most recent trade activity for the key
//   2. the holder's own cost basis
//   3. zero
//
// unrealisedPnl = (currentPrice - costBasis) * quantity. Holdings are sorted
// by currentValue descending so the portfolio page renders top positions
// first.

import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';
import { extractXlmAmount } from '../creator/creator-analytics.service';

export interface HoldingView {
   keyId: string;
   creatorName: string | null;
   avatarUrl: string | null;
   quantity: number;
   currentPrice: number;
   costBasis: number;
   unrealisedPnl: number;
   /** ISO timestamp of the holder's most recent buy, null when never bought. */
   last_buy_timestamp: string | null;
   /**
    * ISO timestamp when the lockup from the last buy expires; null when there
    * is no configured lockup duration or no prior buy.
    */
   lockup_expires_at: string | null;
   /** Self-custody freeze status: true while the position is frozen (#885). */
   frozen: boolean;
}

type KeyOwnershipRow = {
   creatorId: string;
   balance: unknown;
   costBasis: unknown;
   lastBuyAt: Date | null;
   frozen?: boolean;
};

function toNumber(value: unknown): number {
   if (value === null || value === undefined) return 0;
   const parsed = Number(value);
   return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Latest trade price per key id, read from each key's most recent buy/sell
 * activity payload.
 */
async function loadLatestTradePrices(
   keyIds: string[]
): Promise<Map<string, number>> {
   const prices = new Map<string, number>();
   if (keyIds.length === 0) return prices;

   const latestTrades = await prisma.activity.findMany({
      where: {
         creatorId: { in: keyIds },
         type: { in: ['KEY_BOUGHT', 'KEY_SOLD'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { creatorId: true, payload: true },
   });

   for (const trade of latestTrades) {
      if (!trade.creatorId || prices.has(trade.creatorId)) continue;
      const amount = extractXlmAmount(trade.payload);
      if (amount > 0) {
         prices.set(trade.creatorId, amount);
      }
   }
   return prices;
}

/** Compute `lockup_expires_at` from a last-buy timestamp. */
export function computeLockupExpiry(lastBuyAt: Date | null): Date | null {
   if (!lastBuyAt || envConfig.LOCKUP_DURATION_SECONDS <= 0) return null;
   return new Date(
      lastBuyAt.getTime() + envConfig.LOCKUP_DURATION_SECONDS * 1000
   );
}

/**
 * Build the holdings view for a wallet. Returns an empty array when the
 * wallet holds no keys.
 */
export async function getWalletHoldings(wallet: string): Promise<HoldingView[]> {
   const ownerships = (await prisma.keyOwnership.findMany({
      where: { ownerAddress: wallet, balance: { gt: 0 } },
      select: {
         creatorId: true,
         balance: true,
         costBasis: true,
         lastBuyAt: true,
         frozen: true,
      },
   })) as KeyOwnershipRow[];

   if (ownerships.length === 0) {
      return [];
   }

   const keyIds = ownerships.map((row) => row.creatorId);

   const [creatorProfiles, latestPrices] = await Promise.all([
      prisma.creatorProfile.findMany({
         where: {
            OR: [{ id: { in: keyIds } }, { handle: { in: keyIds } }],
         },
         select: { id: true, handle: true, displayName: true, avatarUrl: true },
      }),
      loadLatestTradePrices(keyIds),
   ]);

   const profileByIdentifier = new Map<string, (typeof creatorProfiles)[number]>();
   for (const profile of creatorProfiles) {
      profileByIdentifier.set(profile.id, profile);
      profileByIdentifier.set(profile.handle, profile);
   }

   const holdings = ownerships.map((row) => {
      const profile = profileByIdentifier.get(row.creatorId);
      const quantity = toNumber(row.balance);
      const costBasis = toNumber(row.costBasis);
      const currentPrice =
         latestPrices.get(row.creatorId) ?? (costBasis > 0 ? costBasis : 0);

      const currentValue = currentPrice * quantity;
      const unrealisedPnl = (currentPrice - costBasis) * quantity;
      const lockupExpiresAt = computeLockupExpiry(row.lastBuyAt);

      return {
         keyId: row.creatorId,
         creatorName: profile?.displayName ?? null,
         avatarUrl: profile?.avatarUrl ?? null,
         quantity,
         currentPrice,
         costBasis,
         unrealisedPnl: Number(unrealisedPnl.toFixed(7)),
         currentValue,
         last_buy_timestamp: row.lastBuyAt
            ? row.lastBuyAt.toISOString()
            : null,
          lockup_expires_at: lockupExpiresAt
             ? lockupExpiresAt.toISOString()
             : null,
          frozen: Boolean(row.frozen),
       };
   });

   holdings.sort((left, right) => right.currentValue - left.currentValue);

   // currentValue is an internal sort field only; strip it from the response.
   return holdings.map(({ currentValue: _currentValue, ...view }) => view);
}
