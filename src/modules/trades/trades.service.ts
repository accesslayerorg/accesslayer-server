import { prisma } from '../../utils/prisma.utils';
import { TradesQuery, BundleTradesQuery } from './trades.schemas';
import { decodeCursor, encodeCursor } from '../../utils/cursor.utils';

export interface TradeCursorPayload {
   id: string;
   ledger?: number;
   timestamp?: string;
}

export interface FormattedBundleTrade {
   id: string;
   type: 'bundle';
   wallet: string;
   buyer: string;
   total_cost: string;
   totalCost: string;
   item_count: number;
   itemCount: number;
   items: any[];
   ledger: number;
   tx_hash: string;
   txHash: string;
   timestamp: Date;
   created_at?: Date;
   createdAt?: Date;
}

export interface FormattedSingleTrade {
   id: string;
   type: 'single';
   wallet: string;
   buyer: string;
   creator_id: string;
   creatorId: string;
   quantity: string;
   amount: string;
   price: string;
   ledger: number;
   tx_hash: string;
   txHash: string;
   payment_asset: string;
   paymentAsset: string;
   timestamp: Date;
   created_at?: Date;
   createdAt?: Date;
}

export type FormattedTrade = FormattedSingleTrade | FormattedBundleTrade;

/**
 * Normalizes stored items JSON into parsed array.
 */
function parseStoredItems(rawItems: any): any[] {
   if (Array.isArray(rawItems)) {
      return rawItems;
   }
   if (typeof rawItems === 'string') {
      try {
         const parsed = JSON.parse(rawItems);
         return Array.isArray(parsed) ? parsed : [];
      } catch {
         return [];
      }
   }
   return [];
}

/**
 * Formats a raw bundleTrade database record.
 */
function formatBundleTradeRecord(row: any): FormattedBundleTrade {
   const items = parseStoredItems(row.items);
   const normalizedItems = items.map((item: any) => ({
      key: item.key || item.creatorId || item.creator_id || '',
      creator_id: item.key || item.creatorId || item.creator_id || '',
      creatorId: item.key || item.creatorId || item.creator_id || '',
      amount: item.amount ?? item.quantity ?? 0,
      quantity: item.amount ?? item.quantity ?? 0,
      price: String(item.price ?? '0'),
   }));

   const totalCostStr = String(row.totalCost ?? row.total_cost ?? '0');
   const itemCountNum =
      typeof row.itemCount === 'number'
         ? row.itemCount
         : typeof row.item_count === 'number'
           ? row.item_count
           : normalizedItems.length;

   return {
      id: row.id,
      type: 'bundle',
      wallet: row.wallet || row.buyer || '',
      buyer: row.buyer || row.wallet || '',
      total_cost: totalCostStr,
      totalCost: totalCostStr,
      item_count: itemCountNum,
      itemCount: itemCountNum,
      items: normalizedItems,
      ledger: Number(row.ledger),
      tx_hash: row.txHash || row.tx_hash || '',
      txHash: row.txHash || row.tx_hash || '',
      timestamp:
         row.timestamp instanceof Date
            ? row.timestamp
            : new Date(row.timestamp),
      created_at: row.createdAt
         ? row.createdAt instanceof Date
            ? row.createdAt
            : new Date(row.createdAt)
         : undefined,
      createdAt: row.createdAt
         ? row.createdAt instanceof Date
            ? row.createdAt
            : new Date(row.createdAt)
         : undefined,
   };
}

/**
 * Formats a raw single Trade database record.
 */
function formatSingleTradeRecord(row: any): FormattedSingleTrade {
   const paymentAsset = row.paymentAsset || row.payment_asset || 'XLM';
   return {
      id: row.id,
      type: 'single',
      wallet: row.buyer || '',
      buyer: row.buyer || '',
      creator_id: row.creatorId || row.creator_id || '',
      creatorId: row.creatorId || row.creator_id || '',
      quantity: String(row.quantity ?? '0'),
      amount: String(row.quantity ?? '0'),
      price: String(row.price ?? '0'),
      ledger: Number(row.ledger),
      tx_hash: row.txHash || row.tx_hash || '',
      txHash: row.txHash || row.tx_hash || '',
      payment_asset: paymentAsset,
      paymentAsset: paymentAsset,
      timestamp:
         row.timestamp instanceof Date
            ? row.timestamp
            : new Date(row.timestamp),
      created_at: row.createdAt
         ? row.createdAt instanceof Date
            ? row.createdAt
            : new Date(row.createdAt)
         : undefined,
      createdAt: row.createdAt
         ? row.createdAt instanceof Date
            ? row.createdAt
            : new Date(row.createdAt)
         : undefined,
   };
}

/**
 * Fetches paginated bundle trade history for a given wallet with full per-item breakdown.
 */
export async function fetchWalletBundleTrades(
   wallet: string,
   query: BundleTradesQuery,
   db: any = prisma
): Promise<[FormattedBundleTrade[], number, string | null]> {
   const { limit, offset, page, cursor, from, to } = query;

   const whereClause: any = {
      OR: [{ wallet }, { buyer: wallet }],
   };

   if (from || to) {
      whereClause.timestamp = {};
      if (from) whereClause.timestamp.gte = new Date(from);
      if (to) whereClause.timestamp.lte = new Date(to);
   }

   let rawRows: any[] = [];
   if (db.bundleTrade?.findMany) {
      try {
         rawRows = await db.bundleTrade.findMany({
            where: whereClause,
            orderBy: [
               { timestamp: 'desc' },
               { ledger: 'desc' },
               { id: 'desc' },
            ],
         });
      } catch {
         rawRows = [];
      }
   }

   const formattedList: FormattedBundleTrade[] = rawRows.map(
      formatBundleTradeRecord
   );

   // Sort stable descending: timestamp desc, ledger desc, id desc
   formattedList.sort((a, b) => {
      const tA = a.timestamp.getTime();
      const tB = b.timestamp.getTime();
      if (tB !== tA) return tB - tA;
      if (b.ledger !== a.ledger) return b.ledger - a.ledger;
      return b.id.localeCompare(a.id);
   });

   const total = formattedList.length;

   let startIndex = 0;
   if (cursor) {
      try {
         const decoded = decodeCursor<TradeCursorPayload>(cursor);
         if (decoded && decoded.id) {
            const foundIdx = formattedList.findIndex(
               item => item.id === decoded.id
            );
            if (foundIdx !== -1) {
               startIndex = foundIdx + 1;
            }
         }
      } catch {
         // ignore invalid cursor
      }
   } else if (page && page > 1 && offset === 0) {
      startIndex = (page - 1) * limit;
   } else {
      startIndex = offset;
   }

   const pageItems = formattedList.slice(startIndex, startIndex + limit);
   const hasMore = startIndex + limit < total;
   const lastItem = pageItems[pageItems.length - 1];
   const nextCursor =
      hasMore && lastItem
         ? encodeCursor<TradeCursorPayload>({
              id: lastItem.id,
              ledger: lastItem.ledger,
           })
         : null;

   return [pageItems, total, nextCursor];
}

/**
 * Fetches standard trade history for a given wallet, combining single trades
 * and bundle trades with type flag ('single' or 'bundle').
 */
export async function fetchWalletTrades(
   wallet: string,
   query: TradesQuery,
   db: any = prisma
): Promise<[FormattedTrade[], number, string | null]> {
   const { limit, offset, page, cursor, type, from, to } = query;

   const includeSingle = !type || type === 'all' || type === 'single';
   const includeBundle = !type || type === 'all' || type === 'bundle';

   let singleRows: any[] = [];
   if (includeSingle && db.trade?.findMany) {
      const tradeWhere: any = { buyer: wallet };
      if (from || to) {
         tradeWhere.timestamp = {};
         if (from) tradeWhere.timestamp.gte = new Date(from);
         if (to) tradeWhere.timestamp.lte = new Date(to);
      }
      try {
         singleRows = await db.trade.findMany({
            where: tradeWhere,
            orderBy: [
               { timestamp: 'desc' },
               { ledger: 'desc' },
               { id: 'desc' },
            ],
         });
      } catch {
         singleRows = [];
      }
   }

   let bundleRows: any[] = [];
   if (includeBundle && db.bundleTrade?.findMany) {
      const bundleWhere: any = {
         OR: [{ wallet }, { buyer: wallet }],
      };
      if (from || to) {
         bundleWhere.timestamp = {};
         if (from) bundleWhere.timestamp.gte = new Date(from);
         if (to) bundleWhere.timestamp.lte = new Date(to);
      }
      try {
         bundleRows = await db.bundleTrade.findMany({
            where: bundleWhere,
            orderBy: [
               { timestamp: 'desc' },
               { ledger: 'desc' },
               { id: 'desc' },
            ],
         });
      } catch {
         bundleRows = [];
      }
   }

   const formattedSingles: FormattedSingleTrade[] = singleRows.map(
      formatSingleTradeRecord
   );
   const formattedBundles: FormattedBundleTrade[] = bundleRows.map(
      formatBundleTradeRecord
   );

   const combined: FormattedTrade[] = [
      ...formattedSingles,
      ...formattedBundles,
   ];

   // Sort unified trades by timestamp desc, ledger desc, id desc
   combined.sort((a, b) => {
      const tA = a.timestamp.getTime();
      const tB = b.timestamp.getTime();
      if (tB !== tA) return tB - tA;
      if (b.ledger !== a.ledger) return b.ledger - a.ledger;
      return b.id.localeCompare(a.id);
   });

   const total = combined.length;

   let startIndex = 0;
   if (cursor) {
      try {
         const decoded = decodeCursor<TradeCursorPayload>(cursor);
         if (decoded && decoded.id) {
            const foundIdx = combined.findIndex(item => item.id === decoded.id);
            if (foundIdx !== -1) {
               startIndex = foundIdx + 1;
            }
         }
      } catch {
         // ignore invalid cursor
      }
   } else if (page && page > 1 && offset === 0) {
      startIndex = (page - 1) * limit;
   } else {
      startIndex = offset;
   }

   const pageItems = combined.slice(startIndex, startIndex + limit);
   const hasMore = startIndex + limit < total;
   const lastItem = pageItems[pageItems.length - 1];
   const nextCursor =
      hasMore && lastItem
         ? encodeCursor<TradeCursorPayload>({
              id: lastItem.id,
              ledger: lastItem.ledger,
           })
         : null;

   return [pageItems, total, nextCursor];
}
