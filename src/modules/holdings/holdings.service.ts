// src/modules/holdings/holdings.service.ts
// Builds the per-wallet holdings view used by the portfolio / lockup UI.

import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';

export interface Holding {
   keyId: string;
   creatorName: string;
   avatarUrl: string | null;
   quantity: number;
   currentPrice: number;
   costBasis: number;
   unrealisedPnl: number;
   currentValue: number;
   last_buy_timestamp: string | null;
   lockup_expires_at: string | null;
}

function toNumber(value: unknown): number {
   if (value == null) return 0;
   if (typeof value === 'number') return value;
   try {
      return Number(value.toString());
   } catch {
      return 0;
   }
}

/**
 * Returns the holdings for a wallet, sorted by current value (descending).
 * Returns an empty array (never null) when the wallet holds no keys.
 */
export async function getHoldings(wallet: string): Promise<Holding[]> {
   const ownership = await prisma.keyOwnership.findMany({
      where: { ownerAddress: wallet },
   });

   if (ownership.length === 0) {
      return [];
   }

   const keyIds = ownership.map((o) => o.creatorId);
   const profiles = await prisma.creatorProfile.findMany({
      where: { id: { in: keyIds } },
      select: { id: true, displayName: true, handle: true, avatarUrl: true },
   });
   const profileById = new Map(
      profiles.map((p) => [p.id, p] as const)
   );

   const trades = await prisma.trade.findMany({
      where: { wallet, keyId: { in: keyIds } },
      select: { keyId: true, side: true, amount: true, price: true, createdAt: true },
   });

   const holdings: Holding[] = await Promise.all(
      ownership.map(async (o) => {
         const keyId = o.creatorId;
         const quantity = toNumber(o.balance);
         const profile = profileById.get(keyId);

         const keyTrades = trades.filter((t) => t.keyId === keyId);

         const buys = keyTrades.filter((t) => t.side === 'BUY');
         const lastBuy = buys.length
            ? buys.reduce((a, b) =>
                 a.createdAt > b.createdAt ? a : b
              ).createdAt
            : null;

         const costBasis = buys.reduce(
            (sum, t) => sum + toNumber(t.amount) * toNumber(t.price),
            0
         );

         const latestTrade = await prisma.trade.findFirst({
            where: { keyId },
            orderBy: { createdAt: 'desc' },
            select: { price: true },
         });
         const currentPrice = latestTrade ? toNumber(latestTrade.price) : 0;

         const currentValue = currentPrice * quantity;
         const unrealisedPnl = currentValue - costBasis;

         const lockupExpiresAt = lastBuy
            ? new Date(
                 lastBuy.getTime() + envConfig.KEY_LOCKUP_DURATION_MS
              ).toISOString()
            : null;

         return {
            keyId,
            creatorName: profile?.displayName || profile?.handle || '',
            avatarUrl: profile?.avatarUrl ?? null,
            quantity,
            currentPrice,
            costBasis,
            unrealisedPnl,
            currentValue,
            last_buy_timestamp: lastBuy ? lastBuy.toISOString() : null,
            lockup_expires_at: lockupExpiresAt,
         };
      })
   );

   holdings.sort((a, b) => b.currentValue - a.currentValue);
   return holdings;
}
