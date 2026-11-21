// src/modules/creator/creator-revenue.service.ts
import { prisma } from '../../utils/prisma.utils';

export class KeyNotFoundError extends Error {
  constructor(keyId: string) {
    super(`Key not found: ${keyId}`);
    this.name = 'KeyNotFoundError';
  }
}

export interface CreatorRevenue {
  totalRoyaltyEarned: string;
  totalDividendsDistributed: string;
  tradeCount: number;
}

export async function getCreatorRevenue(keyId: string): Promise<CreatorRevenue> {
  const creator = await prisma.creatorProfile.findUnique({
    where: { id: keyId },
    select: {
      creatorRoyaltyBuyBps: true,
      creatorRoyaltySellBps: true,
    },
  });

  if (!creator) {
    throw new KeyNotFoundError(keyId);
  }

  const trades = await prisma.trade.findMany({
    where: { creatorId: keyId },
    select: { price: true, quantity: true },
  });

  let totalRoyalty = 0n;
  for (const trade of trades) {
    const price = BigInt(trade.price);
    const qty = BigInt(trade.quantity);
    const value = price * qty;
    // Buy trades use buy BPS, sell trades use sell BPS.
    // Since we don't store trade direction here, use the higher of the two as a
    // conservative upper bound. The Horizon webhook handler can refine this with
    // per-trade direction data when available.
    const bps = BigInt(Math.max(creator.creatorRoyaltyBuyBps, creator.creatorRoyaltySellBps));
    totalRoyalty += (value * bps) / 10000n;
  }

  return {
    totalRoyaltyEarned: totalRoyalty.toString(),
    totalDividendsDistributed: '0',
    tradeCount: trades.length,
  };
}
