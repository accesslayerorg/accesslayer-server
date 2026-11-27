import { prisma } from '../../utils/prisma.utils';

export type TradeSide = 'buy' | 'sell';

export interface OutcomeTradeInput {
   side: TradeSide;
   keyId: string;
   quantity: string | number;
   price: string | number;
   fees?: string | number;
   /** Optional override; when omitted, latest price is fetched from DB. */
   latestPrice?: string | number;
}

export interface TradeOutcome {
   side: TradeSide;
   keyId: string;
   quantity: number;
   entryPrice: number;
   latestPrice: number;
   fees: number;
   grossPnl: number;
   netPnl: number;
   pnlPercent: number;
}

const STROOPS_PER_XLM = 10_000_000;

function toFiniteNumber(value: unknown, fallback = 0): number {
   if (value === null || value === undefined) return fallback;
   const num =
      typeof value === 'number'
         ? value
         : typeof (value as { toNumber?: () => number }).toNumber === 'function'
           ? (value as { toNumber: () => number }).toNumber()
           : Number(value);
   return Number.isFinite(num) ? num : fallback;
}

function round7(value: number): number {
   return Math.round(value * STROOPS_PER_XLM) / STROOPS_PER_XLM;
}

export class OutcomeService {
   /**
    * Fetches the latest known price for a key from `CreatorPriceSnapshot`
    * (stored in stroops) and falls back to the most recent `Trade` row.
    */
   static async getLatestPrice(keyId: string): Promise<number | null> {
      const snapshot = await prisma.creatorPriceSnapshot.findUnique({
         where: { creatorId: keyId },
         select: { currentPrice: true },
      });
      if (snapshot && snapshot.currentPrice > 0n) {
         return Number(snapshot.currentPrice) / STROOPS_PER_XLM;
      }

      const latestTrade = await prisma.trade.findFirst({
         where: { creatorId: keyId },
         orderBy: { timestamp: 'desc' },
         select: { price: true },
      });
      if (latestTrade) {
         return toFiniteNumber(latestTrade.price, 0);
      }
      return null;
   }

   /**
    * Computes profit or loss since a trade using the latest price and fees.
    *
    * - Buy:  netPnl = quantity * (latestPrice - entryPrice) - fees
    * - Sell: netPnl = quantity * (entryPrice - latestPrice) - fees
    */
   static async compute(trade: OutcomeTradeInput): Promise<TradeOutcome> {
      const quantity = Math.max(0, toFiniteNumber(trade.quantity, 0));
      const entryPrice = Math.max(0, toFiniteNumber(trade.price, 0));
      const fees = Math.max(0, toFiniteNumber(trade.fees, 0));

      let latestPrice =
         trade.latestPrice !== undefined
            ? toFiniteNumber(trade.latestPrice, entryPrice)
            : await OutcomeService.getLatestPrice(trade.keyId);

      if (latestPrice === null || !Number.isFinite(latestPrice)) {
         latestPrice = entryPrice;
      }

      const priceDiff =
         trade.side === 'buy'
            ? latestPrice - entryPrice
            : entryPrice - latestPrice;

      const grossPnl = round7(quantity * priceDiff);
      const netPnl = round7(grossPnl - fees);
      const basis =
         trade.side === 'buy'
            ? quantity * entryPrice + fees
            : quantity * entryPrice;
      const pnlPercent =
         basis > 0 ? Math.round((netPnl / basis) * 10000) / 100 : 0;

      return {
         side: trade.side,
         keyId: trade.keyId,
         quantity: round7(quantity),
         entryPrice: round7(entryPrice),
         latestPrice: round7(latestPrice),
         fees: round7(fees),
         grossPnl,
         netPnl,
         pnlPercent,
      };
   }
}
