// src/modules/portfolio/portfolio-pnl.service.ts
// Unrealised + realised P&L per held creator key position (#897).
//
// Pricing is always live (no Redis / snapshot cache):
// - per-key mark-to-market price = getSellUnitPrice(supply, fee) (XLM)
// - per-position liquidation value = computeSellPayout(supply, qty, fee) (XLM)
// Mark-to-market values every key at the top-of-book unit price; liquidation
// walks the bonding curve down for the full quantity (plus fees), so
// liquidation <= mark-to-market. The summary exposes both plus their delta.

import { prisma } from '../../utils/prisma.utils';
import {
   computeSellPayout,
   getSellUnitPrice,
} from '../../utils/pricing.utils';

export interface PortfolioPnlPosition {
   keyId: string;
   quantity: number;
   avgBuyPrice: number;
   currentSellPrice: number;
   currentValue: number;
   liquidationValue: number;
   unrealisedPnl: number;
   realisedPnl: number;
}

export interface PortfolioPnlSummary {
   positionCount: number;
   totalUnrealisedPnl: number;
   totalRealisedPnl: number;
   totalCurrentValue: number;
   totalLiquidationValue: number;
   /** mark-to-market total minus liquidation total (>= 0). */
   markToMarketVsLiquidationDelta: number;
}

export interface PortfolioPnlResult {
   positions: PortfolioPnlPosition[];
   summary: PortfolioPnlSummary;
}

const STROOPS_PER_XLM = 10_000_000;
const DEFAULT_PROTOCOL_FEE_BPS = 500;

function toNumber(value: unknown): number {
   if (value === null || value === undefined) return 0;
   const parsed = Number(value);
   return Number.isFinite(parsed) ? parsed : 0;
}

function round7(value: number): number {
   return Number(value.toFixed(7));
}

async function loadProtocolFeeBps(): Promise<number> {
   try {
      const config = await prisma.protocolConfig.findUnique({
         where: { id: 'default' },
         select: { protocolFeeBps: true },
      });
      const fee = Number((config as any)?.protocolFeeBps ?? DEFAULT_PROTOCOL_FEE_BPS);
      return Number.isFinite(fee) && fee >= 0 ? fee : DEFAULT_PROTOCOL_FEE_BPS;
   } catch {
      return DEFAULT_PROTOCOL_FEE_BPS;
   }
}

/**
 * Build the P&L view for a wallet. Reads live bonding-curve inputs
 * (CreatorProfile.circulatingSupply + protocol fee) on every call — no
 * price-snapshot or Redis cache — so the response never serves a stale price.
 */
export async function getPortfolioPnl(wallet: string): Promise<PortfolioPnlResult> {
   const ownerships = (await prisma.keyOwnership.findMany({
      where: { ownerAddress: wallet },
      select: {
         creatorId: true,
         balance: true,
         costBasis: true,
         realisedPnl: true,
      },
   })) as Array<{
      creatorId: string;
      balance: unknown;
      costBasis: unknown;
      realisedPnl?: unknown;
   }>;

   const empty: PortfolioPnlResult = {
      positions: [],
      summary: {
         positionCount: 0,
         totalUnrealisedPnl: 0,
         totalRealisedPnl: 0,
         totalCurrentValue: 0,
         totalLiquidationValue: 0,
         markToMarketVsLiquidationDelta: 0,
      },
   };

   if (ownerships.length === 0) {
      return empty;
   }

   // Lifetime realised includes closed (zero-balance) positions.
   const totalRealisedPnl = round7(
      ownerships.reduce((sum, row) => sum + toNumber((row as any).realisedPnl), 0)
   );

   const open = ownerships.filter(row => toNumber(row.balance) > 0);
   if (open.length === 0) {
      return { positions: [], summary: { ...empty.summary, totalRealisedPnl } };
   }

   const creatorIds = [...new Set(open.map(row => row.creatorId))];
   const [creators, protocolFeeBps] = await Promise.all([
      prisma.creatorProfile.findMany({
         where: { id: { in: creatorIds } },
         select: { id: true, circulatingSupply: true },
      }),
      loadProtocolFeeBps(),
   ]);

   const supplyById = new Map<string, number>();
   for (const creator of creators as Array<{ id: string; circulatingSupply: unknown }>) {
      supplyById.set(creator.id, toNumber(creator.circulatingSupply));
   }

   const positions: PortfolioPnlPosition[] = open.map(row => {
      const quantity = toNumber(row.balance);
      const avgBuyPrice = toNumber(row.costBasis);
      const realisedPnl = round7(toNumber((row as any).realisedPnl));
      const supply = Math.max(0, Math.floor(supplyById.get(row.creatorId) ?? 0));
      const qtyInt = Math.max(0, Math.floor(quantity));

      const unitStroops = supply <= 0 ? 0n : getSellUnitPrice(supply, protocolFeeBps);
      const currentSellPrice = Number(unitStroops) / STROOPS_PER_XLM;
      const currentValue = currentSellPrice * quantity;

      let liquidationStroops: bigint;
      try {
         liquidationStroops =
            supply <= 0 || qtyInt <= 0
               ? 0n
               : computeSellPayout(supply, Math.min(qtyInt, supply), protocolFeeBps);
         // When the wallet holds a fractional quantity the integer floor
         // above understates value; top up the fractional remainder at the
         // unit price so totals stay exact for Decimal balances.
         const remainder = quantity - qtyInt;
         if (remainder > 0 && supply > 0) {
            liquidationStroops += BigInt(Math.round(Number(unitStroops) * remainder));
         }
      } catch {
         liquidationStroops = BigInt(Math.round(Number(unitStroops) * quantity));
      }
      const liquidationValue = Number(liquidationStroops) / STROOPS_PER_XLM;

      return {
         keyId: row.creatorId,
         quantity,
         avgBuyPrice: round7(avgBuyPrice),
         currentSellPrice: round7(currentSellPrice),
         currentValue: round7(currentValue),
         liquidationValue: round7(liquidationValue),
         unrealisedPnl: round7((currentSellPrice - avgBuyPrice) * quantity),
         realisedPnl,
      };
   });

   positions.sort((a, b) => b.currentValue - a.currentValue);

   const totalUnrealisedPnl = round7(
      positions.reduce((sum, p) => sum + p.unrealisedPnl, 0)
   );
   const totalCurrentValue = round7(positions.reduce((sum, p) => sum + p.currentValue, 0));
   const totalLiquidationValue = round7(
      positions.reduce((sum, p) => sum + p.liquidationValue, 0)
   );

   return {
      positions,
      summary: {
         positionCount: positions.length,
         totalUnrealisedPnl,
         totalRealisedPnl,
         totalCurrentValue,
         totalLiquidationValue,
         markToMarketVsLiquidationDelta: round7(totalCurrentValue - totalLiquidationValue),
      },
   };
}
