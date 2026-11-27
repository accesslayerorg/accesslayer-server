// src/services/gains.service.ts
// Realized gains using average-cost accounting (#1218).
//
// Data sources (all amounts are XLM, held internally as integer stroops so no
// floating-point error accumulates):
// - Buys:  `Trade` rows where the wallet is the buyer and the payment asset is
//          XLM. `price` is stroops per key, `quantity` a whole number of keys.
// - Sells: `ActivityLog` rows (`type = 'sell'`) written at sell execution.
//          `amount` is the XLM payout (proceeds) and `payload.quantity` the
//          number of keys sold.
//
// Average cost is tracked per key. A sell consumes cost from the pool in
// proportion to the quantity sold, so partial sells leave the average cost of
// the remaining position unchanged. Buys made before the requested year still
// feed the pool; only sells inside the year (UTC) are reported.

import { prisma } from '../utils/prisma.utils';

const STROOPS_PER_XLM = 10_000_000n;
const XLM_DECIMALS = 7;

export interface GainEvent {
   kind: 'buy' | 'sell';
   keyId: string;
   at: Date;
   /** Stable tiebreaker for events with an identical timestamp. */
   id: string;
   /** Whole number of keys. */
   quantity: bigint;
   /** Buy: total cost. Sell: total proceeds. Both in stroops. */
   stroops: bigint;
}

export interface RealizedGainRow {
   /** ISO-8601 execution time of the sell. */
   date: string;
   keyId: string;
   quantity: string;
   proceeds: string;
   costBasis: string;
   gain: string;
   /**
    * Keys sold that had no matching buy history (e.g. received by transfer).
    * Their cost basis is taken as zero. "0" when the sell was fully matched.
    */
   unmatchedQuantity: string;
}

export interface RealizedGainsTotals {
   proceeds: string;
   costBasis: string;
   gain: string;
   sellCount: number;
}

export interface RealizedGainsResult {
   wallet: string;
   year: number;
   rows: RealizedGainRow[];
   totals: RealizedGainsTotals;
}

/** Formats integer stroops as a fixed 7-decimal XLM string. */
export function formatStroops(value: bigint): string {
   const negative = value < 0n;
   const abs = negative ? -value : value;
   const whole = abs / STROOPS_PER_XLM;
   const frac = (abs % STROOPS_PER_XLM).toString().padStart(XLM_DECIMALS, '0');
   return `${negative ? '-' : ''}${whole}.${frac}`;
}

/** Converts a decimal-ish value (Prisma Decimal, number, numeric string) to stroops. */
export function toStroops(value: unknown): bigint | null {
   if (value === null || value === undefined) return null;
   let fixed: string;
   if (typeof value === 'string') {
      const n = Number(value);
      if (value.trim() === '' || !Number.isFinite(n)) return null;
      fixed = n.toFixed(XLM_DECIMALS);
   } else if (
      typeof value === 'number' ||
      typeof (value as { toFixed?: unknown }).toFixed === 'function'
   ) {
      // number or Prisma.Decimal; Decimal#toFixed is exact.
      fixed = (value as { toFixed: (dp: number) => string }).toFixed(
         XLM_DECIMALS
      );
      if (!/^-?\d+(\.\d+)?$/.test(fixed)) return null;
   } else {
      return null;
   }
   const negative = fixed.startsWith('-');
   const [whole, frac = ''] = (negative ? fixed.slice(1) : fixed).split('.');
   const stroops =
      BigInt(whole) * STROOPS_PER_XLM + BigInt(frac.padEnd(XLM_DECIMALS, '0'));
   return negative ? -stroops : stroops;
}

/** Integer division rounding half up; both operands must be non-negative. */
function divRound(numerator: bigint, denominator: bigint): bigint {
   return (numerator * 2n + denominator) / (denominator * 2n);
}

/** [start, end) of a calendar year in UTC. Safe for years 0000-0099. */
export function yearBoundsUtc(year: number): { start: Date; end: Date } {
   const start = new Date(0);
   start.setUTCFullYear(year, 0, 1);
   start.setUTCHours(0, 0, 0, 0);
   const end = new Date(0);
   end.setUTCFullYear(year + 1, 0, 1);
   end.setUTCHours(0, 0, 0, 0);
   return { start, end };
}

/**
 * Pure average-cost calculation. Events may be supplied in any order; they are
 * replayed chronologically per key (buys before sells at the same instant).
 * Only sells inside `[start, end)` produce rows.
 */
export function computeAverageCostGains(
   events: GainEvent[],
   start: Date,
   end: Date
): { rows: RealizedGainRow[]; totals: RealizedGainsTotals } {
   const ordered = [...events].sort((a, b) => {
      const dt = a.at.getTime() - b.at.getTime();
      if (dt !== 0) return dt;
      if (a.kind !== b.kind) return a.kind === 'buy' ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
   });

   const pools = new Map<string, { quantity: bigint; cost: bigint }>();
   const rows: RealizedGainRow[] = [];
   let totalProceeds = 0n;
   let totalCost = 0n;

   for (const event of ordered) {
      if (event.quantity <= 0n) continue;
      let pool = pools.get(event.keyId);
      if (!pool) {
         pool = { quantity: 0n, cost: 0n };
         pools.set(event.keyId, pool);
      }

      if (event.kind === 'buy') {
         pool.quantity += event.quantity;
         pool.cost += event.stroops;
         continue;
      }

      const matched =
         event.quantity < pool.quantity ? event.quantity : pool.quantity;
      const cost =
         matched === 0n ? 0n : divRound(pool.cost * matched, pool.quantity);
      pool.quantity -= matched;
      pool.cost -= cost;

      const at = event.at.getTime();
      if (at < start.getTime() || at >= end.getTime()) continue;

      totalProceeds += event.stroops;
      totalCost += cost;
      rows.push({
         date: event.at.toISOString(),
         keyId: event.keyId,
         quantity: event.quantity.toString(),
         proceeds: formatStroops(event.stroops),
         costBasis: formatStroops(cost),
         gain: formatStroops(event.stroops - cost),
         unmatchedQuantity: (event.quantity - matched).toString(),
      });
   }

   return {
      rows,
      totals: {
         proceeds: formatStroops(totalProceeds),
         costBasis: formatStroops(totalCost),
         gain: formatStroops(totalProceeds - totalCost),
         sellCount: rows.length,
      },
   };
}

function parseWholeQuantity(value: unknown): bigint | null {
   if (typeof value === 'bigint') return value;
   if (typeof value === 'number') {
      return Number.isSafeInteger(value) ? BigInt(value) : null;
   }
   if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
      return BigInt(value.trim());
   }
   return null;
}

function parsePositiveStroopPrice(value: unknown): bigint | null {
   if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
   return BigInt(value.trim());
}

export const GainsService = {
   /**
    * Realized gains for `wallet` on every sell executed in `year` (UTC),
    * using average-cost accounting over the wallet's full buy history up to
    * the end of that year. Returns no rows and zero totals when the wallet
    * has no sells in the year.
    */
   async computeRealizedGains(
      wallet: string,
      year: number
   ): Promise<RealizedGainsResult> {
      const { start, end } = yearBoundsUtc(year);

      const [trades, sells] = await Promise.all([
         prisma.trade.findMany({
            where: {
               buyer: wallet,
               paymentAsset: 'XLM',
               timestamp: { lt: end },
            },
            select: {
               id: true,
               creatorId: true,
               quantity: true,
               price: true,
               timestamp: true,
            },
            orderBy: [{ creatorId: 'asc' }, { timestamp: 'asc' }],
         }),
         prisma.activityLog.findMany({
            where: {
               actor: wallet,
               type: 'sell',
               keyId: { not: null },
               timestamp: { lt: end },
            },
            select: {
               id: true,
               keyId: true,
               amount: true,
               payload: true,
               timestamp: true,
            },
            orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
         }),
      ]);

      const events: GainEvent[] = [];

      for (const trade of trades) {
         const quantity = parseWholeQuantity(trade.quantity);
         const price = parsePositiveStroopPrice(trade.price);
         if (quantity === null || price === null) continue;
         events.push({
            kind: 'buy',
            keyId: trade.creatorId,
            at: trade.timestamp,
            id: trade.id,
            quantity,
            stroops: price * quantity,
         });
      }

      for (const sell of sells) {
         if (!sell.keyId) continue;
         const payload = (sell.payload ?? {}) as Record<string, unknown>;
         const quantity = parseWholeQuantity(payload.quantity);
         const proceeds = toStroops(sell.amount ?? payload.payoutXlm);
         if (quantity === null || proceeds === null) continue;
         events.push({
            kind: 'sell',
            keyId: sell.keyId,
            at: sell.timestamp,
            id: sell.id,
            quantity,
            stroops: proceeds,
         });
      }

      const { rows, totals } = computeAverageCostGains(events, start, end);
      return { wallet, year, rows, totals };
   },
};
