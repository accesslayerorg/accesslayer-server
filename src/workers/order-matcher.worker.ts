// src/workers/order-matcher.worker.ts
// Price-trigger matching for limit orders (#1220).
//
// Every 5 seconds the worker walks every OPEN order in keyset pages and
// compares it with the latest indexed curve price
// (creator_price_snapshots.currentPrice, in stroops):
//
//   BUY  -> EXECUTABLE when price <= target
//   SELL -> EXECUTABLE when price >= target
//
// Paging by (createdAt, id) covers all OPEN orders each pass, so the newest
// orders can never be starved by a backlog of older ones. Expired orders become
// EXPIRED regardless of price and are never executable. Each page's status
// changes commit in one transaction, and `order.executable` events are emitted
// only after that transaction commits.

import { logger } from '../utils/logger.utils';
import { prisma } from '../utils/prisma.utils';
import type { OrderSide } from '../modules/orders/order.schemas';
import {
   emitOrderExecutable,
   OrderExecutableEvent,
} from '../modules/orders/order-events.utils';
import { xlmToStroops } from '../modules/orders/order.service';

export const ORDER_MATCHER_INTERVAL_MS = 5000;
const ORDER_MATCHER_PAGE_SIZE = 500;

export interface OrderMatcherResult {
   scanned: number;
   executable: number;
   expired: number;
}

interface OpenOrder {
   id: string;
   wallet: string;
   keyId: string;
   side: string;
   targetPrice: { toString(): string };
   quantity: { toString(): string };
   expiresAt: Date | null;
   createdAt: Date;
}

interface OrderCursor {
   createdAt: Date;
   id: string;
}

interface PriceSnapshot {
   creatorId: string;
   currentPrice: bigint;
}

function isSide(value: string): value is OrderSide {
   return value === 'BUY' || value === 'SELL';
}

/**
 * Evaluate a single order against the current price.
 *
 * @returns `'executable'`, `'expired'` or `null` when the order should stay
 * open. Expiry is checked first so an expired order can never be executable.
 */
function classifyOrder(
   order: Pick<OpenOrder, 'side' | 'targetPrice' | 'expiresAt'>,
   currentPriceStroops: bigint | undefined,
   now: Date
): 'executable' | 'expired' | null {
   if (order.expiresAt && order.expiresAt.getTime() <= now.getTime()) {
      return 'expired';
   }

   if (currentPriceStroops === undefined || !isSide(order.side)) {
      return null;
   }

   const targetStroops = xlmToStroops(order.targetPrice.toString());

   if (order.side === 'BUY') {
      return currentPriceStroops <= targetStroops ? 'executable' : null;
   }

   return currentPriceStroops >= targetStroops ? 'executable' : null;
}

/** Load one page of OPEN orders strictly after `cursor`. */
async function loadOrderPage(
   cursor: OrderCursor | undefined
): Promise<OpenOrder[]> {
   const where = cursor
      ? {
           status: 'OPEN',
           OR: [
              { createdAt: { gt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { gt: cursor.id } },
           ],
        }
      : { status: 'OPEN' };

   return (await prisma.limitOrder.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: ORDER_MATCHER_PAGE_SIZE,
      select: {
         id: true,
         wallet: true,
         keyId: true,
         side: true,
         targetPrice: true,
         quantity: true,
         expiresAt: true,
         createdAt: true,
      },
   })) as OpenOrder[];
}

/**
 * Classify and persist one page of OPEN orders.
 *
 * @returns Per-page counts for the run summary.
 */
async function processOrderPage(
   openOrders: OpenOrder[],
   now: Date
): Promise<OrderMatcherResult> {
   const keyIds = [...new Set(openOrders.map(order => order.keyId))];
   const snapshots = (await prisma.creatorPriceSnapshot.findMany({
      where: { creatorId: { in: keyIds } },
      select: { creatorId: true, currentPrice: true },
   })) as PriceSnapshot[];

   const prices = new Map<string, bigint>();
   for (const snapshot of snapshots) {
      prices.set(snapshot.creatorId, BigInt(snapshot.currentPrice.toString()));
   }

   const executableOrders: OpenOrder[] = [];
   const expiredIds: string[] = [];

   for (const order of openOrders) {
      const outcome = classifyOrder(order, prices.get(order.keyId), now);
      if (outcome === 'expired') {
         expiredIds.push(order.id);
      } else if (outcome === 'executable') {
         executableOrders.push(order);
      }
   }

   if (executableOrders.length === 0 && expiredIds.length === 0) {
      return { scanned: openOrders.length, executable: 0, expired: 0 };
   }

   await prisma.$transaction(async tx => {
      if (expiredIds.length > 0) {
         await tx.limitOrder.updateMany({
            where: { id: { in: expiredIds }, status: 'OPEN' },
            data: { status: 'EXPIRED' },
         });
      }

      if (executableOrders.length > 0) {
         await tx.limitOrder.updateMany({
            where: {
               id: { in: executableOrders.map(order => order.id) },
               status: 'OPEN',
            },
            data: { status: 'EXECUTABLE' },
         });
      }
   });

   const triggeredAt = now.toISOString();
   for (const order of executableOrders) {
      const event: OrderExecutableEvent = {
         type: 'order.executable',
         orderId: order.id,
         wallet: order.wallet,
         keyId: order.keyId,
         side: order.side as OrderSide,
         targetPrice: order.targetPrice.toString(),
         quantity: order.quantity.toString(),
         currentPrice: prices.get(order.keyId)!.toString(),
         triggeredAt,
      };
      emitOrderExecutable(event);
   }

   return {
      scanned: openOrders.length,
      executable: executableOrders.length,
      expired: expiredIds.length,
   };
}

/**
 * Run one matching pass over every OPEN order.
 *
 * @param now - Clock used for expiry checks (injectable for tests).
 */
export async function runOrderMatcher(
   now: Date = new Date()
): Promise<OrderMatcherResult> {
   const result: OrderMatcherResult = {
      scanned: 0,
      executable: 0,
      expired: 0,
   };

   let cursor: OrderCursor | undefined;

   for (;;) {
      const page = await loadOrderPage(cursor);
      if (page.length === 0) {
         break;
      }

      const pageResult = await processOrderPage(page, now);
      result.scanned += pageResult.scanned;
      result.executable += pageResult.executable;
      result.expired += pageResult.expired;

      if (pageResult.executable > 0 || pageResult.expired > 0) {
         logger.info(
            {
               scanned: pageResult.scanned,
               executable: pageResult.executable,
               expired: pageResult.expired,
            },
            'order matcher: page completed'
         );
      }

      if (page.length < ORDER_MATCHER_PAGE_SIZE) {
         break;
      }

      const lastOrder = page[page.length - 1];
      cursor = { createdAt: lastOrder.createdAt, id: lastOrder.id };
   }

   return result;
}

let matcherTimer: ReturnType<typeof setInterval> | null = null;
let matcherRunning = false;

export function startOrderMatcherWorker(): void {
   if (matcherTimer) {
      return;
   }

   const run = async () => {
      if (matcherRunning) {
         return;
      }
      matcherRunning = true;
      try {
         await runOrderMatcher();
      } catch (error) {
         logger.error({ err: error }, 'order matcher: batch failed');
      } finally {
         matcherRunning = false;
      }
   };

   void run();
   matcherTimer = setInterval(() => {
      void run();
   }, ORDER_MATCHER_INTERVAL_MS);

   if (
      typeof (matcherTimer as unknown as { unref?: () => void }).unref ===
      'function'
   ) {
      (matcherTimer as unknown as { unref: () => void }).unref();
   }

   logger.info(
      { intervalMs: ORDER_MATCHER_INTERVAL_MS },
      'order matcher worker started'
   );
}

export function stopOrderMatcherWorker(): void {
   if (!matcherTimer) {
      return;
   }
   clearInterval(matcherTimer);
   matcherTimer = null;
   logger.info('order matcher worker stopped');
}
