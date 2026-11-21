// src/modules/staking/vault.service.ts
// Staking vault read model: per-wallet position, claimable rewards, and the
// vault-wide summary. State comes from VaultPosition rows kept in sync with
// VaultDeposit / VaultWithdraw contract events (see vault-indexer.service).
//
// Valuation is always live: each key is priced at the bonding-curve sell unit
// price for its creator's current circulating supply, like portfolio P&L.

import { prisma } from '../../utils/prisma.utils';
import { getSellUnitPrice } from '../../utils/pricing.utils';
import {
   finalizeCycle,
   getLatestEndedCycle,
} from '../revenue/revenue.service';

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

export interface VaultKeyBreakdown {
   keyId: string;
   quantity: number;
   unitPrice: number;
   value: number;
   /** This position's value as a fraction (0-1) of the whole vault's TVL. */
   shareOfVault: number;
}

export interface VaultPositionResult {
   wallet: string;
   /** The wallet's fraction (0-1) of total vault value. */
   shareOfVault: number;
   totalValueXlm: number;
   vaultTvlXlm: number;
   keys: VaultKeyBreakdown[];
}

export interface VaultSummaryResult {
   tvlXlm: number;
   depositorCount: number;
   keyCount: number;
}

export interface VaultRewardsResult {
   wallet: string;
   claimableXlm: string;
   claimed: boolean;
   cycle: {
      cycleIndex: number;
      startsAt: string;
      endsAt: string;
      totalFeesXlm: string;
   } | null;
}

async function loadProtocolFeeBps(): Promise<number> {
   try {
      const config = await prisma.protocolConfig.findUnique({
         where: { id: 'default' },
         select: { protocolFeeBps: true },
      });
      const fee = Number(config?.protocolFeeBps ?? DEFAULT_PROTOCOL_FEE_BPS);
      return Number.isFinite(fee) && fee >= 0 ? fee : DEFAULT_PROTOCOL_FEE_BPS;
   } catch {
      return DEFAULT_PROTOCOL_FEE_BPS;
   }
}

/** Live per-key unit price (XLM) for each creator id. */
async function loadUnitPrices(creatorIds: string[]): Promise<Map<string, number>> {
   const prices = new Map<string, number>();
   if (creatorIds.length === 0) return prices;

   const [creators, feeBps] = await Promise.all([
      prisma.creatorProfile.findMany({
         where: { id: { in: creatorIds } },
         select: { id: true, circulatingSupply: true },
      }),
      loadProtocolFeeBps(),
   ]);

   for (const creator of creators) {
      const supply = Math.max(0, Math.floor(toNumber(creator.circulatingSupply)));
      const unit = supply <= 0 ? 0n : getSellUnitPrice(supply, feeBps);
      prices.set(creator.id, Number(unit) / STROOPS_PER_XLM);
   }
   return prices;
}

/** Total vault quantity per creator, across all depositors. */
async function loadVaultTotalsByCreator(): Promise<
   Array<{ creatorId: string; quantity: number }>
> {
   const grouped = await prisma.vaultPosition.groupBy({
      by: ['creatorId'],
      where: { quantity: { gt: 0 } },
      _sum: { quantity: true },
   });
   return grouped.map(row => ({
      creatorId: row.creatorId,
      quantity: toNumber(row._sum.quantity),
   }));
}

function computeTvl(
   totals: Array<{ creatorId: string; quantity: number }>,
   prices: Map<string, number>
): number {
   return totals.reduce(
      (sum, row) => sum + row.quantity * (prices.get(row.creatorId) ?? 0),
      0
   );
}

/** The wallet's vault share and per-key breakdown. */
export async function getVaultPosition(
   wallet: string
): Promise<VaultPositionResult> {
   const [rows, totals] = await Promise.all([
      prisma.vaultPosition.findMany({
         where: { wallet, quantity: { gt: 0 } },
         select: { creatorId: true, quantity: true },
         orderBy: { creatorId: 'asc' },
      }),
      loadVaultTotalsByCreator(),
   ]);

   if (rows.length === 0) {
      const prices = await loadUnitPrices(totals.map(t => t.creatorId));
      return {
         wallet,
         shareOfVault: 0,
         totalValueXlm: 0,
         vaultTvlXlm: round7(computeTvl(totals, prices)),
         keys: [],
      };
   }

   const creatorIds = [
      ...new Set([...rows.map(r => r.creatorId), ...totals.map(t => t.creatorId)]),
   ];
   const prices = await loadUnitPrices(creatorIds);
   const tvl = computeTvl(totals, prices);

   const keys: VaultKeyBreakdown[] = rows.map(row => {
      const quantity = toNumber(row.quantity);
      const unitPrice = prices.get(row.creatorId) ?? 0;
      const value = quantity * unitPrice;
      return {
         keyId: row.creatorId,
         quantity,
         unitPrice: round7(unitPrice),
         value: round7(value),
         shareOfVault: tvl > 0 ? round7(value / tvl) : 0,
      };
   });

   const totalValue = keys.reduce((sum, k) => sum + k.value, 0);
   return {
      wallet,
      shareOfVault: tvl > 0 ? round7(totalValue / tvl) : 0,
      totalValueXlm: round7(totalValue),
      vaultTvlXlm: round7(tvl),
      keys,
   };
}

/** Vault-wide TVL and number of distinct depositors. */
export async function getVaultSummary(): Promise<VaultSummaryResult> {
   const [totals, depositors] = await Promise.all([
      loadVaultTotalsByCreator(),
      prisma.vaultPosition.groupBy({
         by: ['wallet'],
         where: { quantity: { gt: 0 } },
      }),
   ]);
   const prices = await loadUnitPrices(totals.map(t => t.creatorId));
   return {
      tvlXlm: round7(computeTvl(totals, prices)),
      depositorCount: depositors.length,
      keyCount: totals.length,
   };
}

/**
 * Claimable vault rewards: the wallet's share of the latest ended revenue
 * cycle's fee pool, weighted by deposited key quantity (matching the stake
 * weight convention of the revenue module). Zero once the wallet has claimed
 * that cycle.
 */
export async function getVaultRewards(
   wallet: string,
   now: Date = new Date()
): Promise<VaultRewardsResult> {
   const window = getLatestEndedCycle(now);
   if (!window) {
      return { wallet, claimableXlm: '0', claimed: false, cycle: null };
   }

   const cycle = await finalizeCycle(window);
   const cycleView = {
      cycleIndex: cycle.cycleIndex,
      startsAt: cycle.startsAt.toISOString(),
      endsAt: cycle.endsAt.toISOString(),
      totalFeesXlm: cycle.totalFeesXlm.toString(),
   };

   const existing = await prisma.revenueClaim.findUnique({
      where: { cycleId_wallet: { cycleId: cycle.id, wallet } },
   });
   if (existing?.claimedAt) {
      return { wallet, claimableXlm: '0', claimed: true, cycle: cycleView };
   }

   const [walletAgg, totalAgg] = await Promise.all([
      prisma.vaultPosition.aggregate({
         where: { wallet, quantity: { gt: 0 } },
         _sum: { quantity: true },
      }),
      prisma.vaultPosition.aggregate({
         where: { quantity: { gt: 0 } },
         _sum: { quantity: true },
      }),
   ]);
   const walletQty = toNumber(walletAgg._sum.quantity);
   const totalQty = toNumber(totalAgg._sum.quantity);

   const claimable =
      cycle.totalFeesXlm > 0 && walletQty > 0 && totalQty > 0
         ? (cycle.totalFeesXlm * walletQty) / totalQty
         : 0;

   return {
      wallet,
      claimableXlm: claimable.toFixed(7),
      claimed: false,
      cycle: cycleView,
   };
}
