import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { OwnershipQueryType } from './ownership.schemas';
import { recordHoldingSnapshot } from '../portfolio/holding-snapshot.service';
import { onHolderBalanceChanged } from '../keys/key-holder-leaderboard.service';

type KeyOwnership = NonNullable<
   Awaited<ReturnType<typeof prisma.keyOwnership.findFirst>>
>;

import { truncateWallet } from '../../utils/wallet-display.utils';
export async function fetchOwnership(
   query: OwnershipQueryType
): Promise<KeyOwnership[]> {
   const { ownerAddress, creatorId } = query;

   const where: any = {};
   if (ownerAddress) where.ownerAddress = ownerAddress;
   if (creatorId) where.creatorId = creatorId;

   return prisma.keyOwnership.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
   });
}

export interface OwnershipUpdateContext {
   event_type?: 'buy' | 'sell';
   ledger_sequence?: number;
   /** When the trade occurred; used for the holdings snapshot timestamp (#1008). */
   occurredAt?: Date;
}

export async function updateOwnership(
   ownerAddress: string,
   creatorId: string,
   balanceChange: number,
   ctx: OwnershipUpdateContext = {}
): Promise<KeyOwnership> {
   const existing = await prisma.keyOwnership.findFirst({
      where: { ownerAddress, creatorId },
      select: { balance: true },
   });
   const previousBalance = existing ? Number(existing.balance) : 0;

   const result = await prisma.keyOwnership.upsert({
      where: {
         ownerAddress_creatorId: {
            ownerAddress,
            creatorId,
         },
      },
      update: {
         balance: { increment: balanceChange },
      },
      create: {
         ownerAddress,
         creatorId,
         balance: balanceChange,
      },
   });

   logger.debug(
      {
         creator_id: creatorId,
         wallet_address: truncateWallet(ownerAddress),
         previous_balance: previousBalance,
         new_balance: Number(result.balance),
         event_type: ctx.event_type,
         ledger_sequence: ctx.ledger_sequence,
      },
      'Ownership read model updated'
   );

   // Holdings snapshot for the portfolio history chart (#1008).
   await recordHoldingSnapshot({
      ownerAddress,
      creatorId,
      balance: Number(result.balance),
      recordedAt: ctx.occurredAt ?? new Date(),
   });

   // Recompute the holder leaderboard after the balance change (#1013).
   await onHolderBalanceChanged(creatorId);

   return result;
}

/**
 * Record a key buy, updating balance, weighted-average cost basis and
 * lastBuyAt. Buy ingestion paths must call this (and invalidate the caches
 * exposed by analytics/holdings/referrals modules) so portfolio data stays
 * accurate.
 */
export async function recordKeyPurchase(
    ownerAddress: string,
    creatorId: string,
    quantityBought: number,
    pricePerKeyXlm: number,
    boughtAt: Date = new Date()
): Promise<KeyOwnership> {
    const existing = await prisma.keyOwnership.findUnique({
        where: {
            ownerAddress_creatorId: { ownerAddress, creatorId },
        },
        select: { balance: true, costBasis: true },
    });

    const currentBalance = Number(existing?.balance ?? 0);
    const currentCostBasis = Number(existing?.costBasis ?? 0);

    const newBalance = Math.max(0, currentBalance + quantityBought);
    // Weighted average cost across the open position; resets when flat or
    // when rebuilding from zero (#897: prior balance 0 => fresh cost basis).
    let newCostBasis: number;
    if (newBalance === 0) {
        newCostBasis = 0;
    } else if (currentBalance <= 0) {
        newCostBasis = pricePerKeyXlm;
    } else {
        newCostBasis =
            (currentCostBasis * currentBalance + pricePerKeyXlm * quantityBought) /
            newBalance;
    }

    const updated = (await (prisma.keyOwnership.upsert({
        where: {
            ownerAddress_creatorId: { ownerAddress, creatorId },
        },
        update: {
            balance: { increment: quantityBought },
            costBasis: newCostBasis,
            lastBuyAt: boughtAt,
        },
        create: {
            ownerAddress,
            creatorId,
            balance: quantityBought,
            costBasis: pricePerKeyXlm,
            lastBuyAt: boughtAt,
        },
    }) as unknown)) as KeyOwnership;

    // Holdings snapshot for the portfolio history chart (#1008).
    await recordHoldingSnapshot({
        ownerAddress,
        creatorId,
        balance: Number(updated.balance),
        recordedAt: boughtAt,
    });

    // Recompute the holder leaderboard after the balance change (#1013).
    await onHolderBalanceChanged(creatorId);

    return updated;
}

export class InsufficientKeyBalanceError extends Error {
    constructor() {
        super('Insufficient key balance for sell');
        this.name = 'InsufficientKeyBalanceError';
    }
}

/**
 * Pure realised-P&L math for a sell (#897).
 * Kept separate so the transactional sell path in
 * `creator/sell.controller.ts` can reuse it atomically via its `tx` client.
 */
export function computeRealisedPnlForSale(
    costBasisPerKeyXlm: number,
    sellPricePerKeyXlm: number,
    quantitySold: number
): number {
    return (sellPricePerKeyXlm - costBasisPerKeyXlm) * quantitySold;
}

/** Cost basis after a sell: unchanged on partial sells, reset when flat. */
export function computeCostBasisAfterSale(
    currentCostBasis: number,
    currentBalance: number,
    quantitySold: number
): number {
    return currentBalance - quantitySold <= 0 ? 0 : currentCostBasis;
}

/**
 * Record a key sell, persisting realised P&L at execution time (#897).
 * Partial sells keep the average cost basis; full sells reset it to zero
 * while preserving lifetime realised P&L.
 */
export async function recordKeySale(
    ownerAddress: string,
    creatorId: string,
    quantitySold: number,
    pricePerKeyXlm: number,
    soldAt: Date = new Date()
): Promise<KeyOwnership> {
    const existing = await prisma.keyOwnership.findUnique({
        where: {
            ownerAddress_creatorId: { ownerAddress, creatorId },
        },
        select: { balance: true, costBasis: true, realisedPnl: true },
    });

    const currentBalance = Number((existing as any)?.balance ?? 0);
    const currentCostBasis = Number((existing as any)?.costBasis ?? 0);
    const currentRealised = Number((existing as any)?.realisedPnl ?? 0);

    if (!existing || currentBalance < quantitySold) {
        throw new InsufficientKeyBalanceError();
    }

    const realisedForTrade = computeRealisedPnlForSale(
        currentCostBasis,
        pricePerKeyXlm,
        quantitySold
    );
    const newBalance = currentBalance - quantitySold;
    const newCostBasis = computeCostBasisAfterSale(
        currentCostBasis,
        currentBalance,
        quantitySold
    );

    const updated = (await (prisma.keyOwnership.update({
        where: {
            ownerAddress_creatorId: { ownerAddress, creatorId },
        },
        data: {
            balance: newBalance,
            costBasis: newCostBasis,
            realisedPnl: currentRealised + realisedForTrade,
        },
    }) as unknown)) as KeyOwnership;

    // Holdings snapshot for the portfolio history chart (#1008).
    await recordHoldingSnapshot({
        ownerAddress,
        creatorId,
        balance: Number(updated.balance),
        recordedAt: soldAt,
    });

    // Recompute the holder leaderboard after the balance change (#1013).
    await onHolderBalanceChanged(creatorId);

    return updated;
}
