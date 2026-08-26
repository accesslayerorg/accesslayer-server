// src/modules/trade/trade.service.ts
// Records key buy/sell activity and keeps ownership balances in sync.

import { prisma } from '../../utils/prisma.utils';
import { invalidateAnalyticsCache } from '../analytics/analytics.cache';

export type TradeSide = 'BUY' | 'SELL';

export interface ExecuteTradeInput {
   keyId: string;
   creatorId: string;
   wallet: string;
   side: TradeSide;
   amount: number;
   price: number;
   txHash: string;
}

export interface TradeResult {
   id: string;
   keyId: string;
   wallet: string;
   side: TradeSide;
   amount: number;
   price: number;
   createdAt: string;
}

/**
 * Persists a single trade, updates the owner's key balance, and invalidates the
 * key analytics cache so the next dashboard fetch reflects the new activity.
 *
 * The unique `txHash` constraint makes accidental double-writes from the
 * indexer safe; idempotency at the HTTP layer prevents re-execution on client
 * retries.
 */
export async function executeTrade(
   input: ExecuteTradeInput
): Promise<TradeResult> {
   const created = await prisma.$transaction(async (tx) => {
      const trade = await tx.trade.create({
         data: {
            keyId: input.keyId,
            creatorId: input.creatorId,
            wallet: input.wallet,
            side: input.side,
            amount: input.amount,
            price: input.price,
            txHash: input.txHash,
         },
      });

      const balanceDelta = input.side === 'BUY' ? input.amount : -input.amount;
      await tx.keyOwnership.upsert({
         where: {
            ownerAddress_creatorId: {
               ownerAddress: input.wallet,
               creatorId: input.creatorId,
            },
         },
         update: { balance: { increment: balanceDelta } },
         create: {
            ownerAddress: input.wallet,
            creatorId: input.creatorId,
            balance: balanceDelta,
         },
      });

      return trade;
   });

   await invalidateAnalyticsCache(input.keyId);

   return {
      id: created.id,
      keyId: created.keyId,
      wallet: created.wallet,
      side: created.side as TradeSide,
      amount: Number(created.amount),
      price: Number(created.price),
      createdAt: created.createdAt.toISOString(),
   };
}

/**
 * Resolves the creator id that owns a key (creator profile id === key id).
 */
export async function resolveCreatorId(keyId: string): Promise<string | null> {
   const profile = await prisma.creatorProfile.findUnique({
      where: { id: keyId },
      select: { id: true },
   });
   return profile?.id ?? null;
}
