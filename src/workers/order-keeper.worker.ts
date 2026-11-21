import { envConfig } from '../config';
import type { OrderSide } from '../modules/orders/order.schemas';
import { xlmToStroops } from '../modules/orders/order.service';
import { logger } from '../utils/logger.utils';
import { prisma } from '../utils/prisma.utils';
import {
   recordKeeperFill,
   recordKeeperSkipped,
} from '../utils/order-keeper-metrics.utils';

export const ORDER_KEEPER_INTERVAL_MS = 5000;
const ORDER_KEEPER_PAGE_SIZE = 500;
const BASIS_POINTS = 10_000n;

export type KeeperOrderStatus = 'OPEN' | 'FILLED' | 'CANCELLED' | 'EXPIRED';

export interface KeeperOrder {
   id: string;
   wallet: string;
   keyId: string;
   side: string;
   targetPrice: { toString(): string };
   quantity: { toString(): string };
   expiresAt: Date | null;
   createdAt: Date;
}

export interface OrderKeeperClient {
   /** Read the escrow contract's authoritative status for this order. */
   getOrderStatus(orderId: string): Promise<KeeperOrderStatus>;
   /** Simulate the fill and return both amounts in stroops. */
   simulateFill(
      order: KeeperOrder
   ): Promise<{ keeperRewardStroops: bigint; estimatedFeeStroops: bigint }>;
   /** Read the keeper account's current sequence number. */
   getSequence(): Promise<string>;
   /**
    * Sign, submit, and confirm a fill using the supplied account sequence.
    * Reject with `tx_bad_seq` if the sequence is stale.
    */
   fillOrder(order: KeeperOrder, sequence: string): Promise<void>;
}

export interface OrderKeeperWorkerOptions {
   intervalMs?: number;
   profitMarginBps?: number;
   now?: () => Date;
}

interface OrderCursor {
   createdAt: Date;
   id: string;
}

interface PriceSnapshot {
   creatorId: string;
   currentPrice: bigint;
}

function isOrderSide(value: string): value is OrderSide {
   return value === 'BUY' || value === 'SELL';
}

function isBadSequenceError(error: unknown): boolean {
   const message =
      error instanceof Error ? error.message : String(error ?? '');
   const code =
      typeof error === 'object' && error !== null && 'code' in error
         ? String(error.code)
         : '';
   return /tx_bad_seq|bad sequence/i.test(`${code} ${message}`);
}

function meetsPriceCondition(order: KeeperOrder, currentPrice: bigint): boolean {
   if (!isOrderSide(order.side)) {
      return false;
   }
   const targetPrice = xlmToStroops(order.targetPrice.toString());
   return order.side === 'BUY'
      ? currentPrice <= targetPrice
      : currentPrice >= targetPrice;
}

function isProfitable(
   rewardStroops: bigint,
   feeStroops: bigint,
   marginBps: number
): boolean {
   if (rewardStroops <= 0n || feeStroops < 0n) {
      return false;
   }
   return (
      rewardStroops * BASIS_POINTS >=
      feeStroops * (BASIS_POINTS + BigInt(marginBps))
   );
}

async function loadOrderPage(
   cursor: OrderCursor | undefined
): Promise<KeeperOrder[]> {
   const where = {
      status: { in: ['OPEN', 'EXECUTABLE'] },
      ...(cursor
         ? {
              OR: [
                 { createdAt: { gt: cursor.createdAt } },
                 { createdAt: cursor.createdAt, id: { gt: cursor.id } },
              ],
           }
         : {}),
   };

   return (await prisma.limitOrder.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: ORDER_KEEPER_PAGE_SIZE,
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
   })) as KeeperOrder[];
}

export class OrderKeeperWorker {
   private readonly intervalMs: number;
   private readonly profitMarginBps: number;
   private readonly now: () => Date;
   private timer: ReturnType<typeof setInterval> | null = null;
   private cycleInFlight = false;

   constructor(
      private readonly client: OrderKeeperClient,
      options: OrderKeeperWorkerOptions = {}
   ) {
      this.intervalMs = options.intervalMs ?? ORDER_KEEPER_INTERVAL_MS;
      this.profitMarginBps =
         options.profitMarginBps ?? envConfig.ORDER_KEEPER_PROFIT_MARGIN_BPS;
      this.now = options.now ?? (() => new Date());
   }

   start(): void {
      if (this.timer) {
         logger.warn('Order keeper worker is already running');
         return;
      }

      void this.runCycle().catch(error => {
         logger.error({ err: error }, 'Order keeper cycle failed');
      });
      this.timer = setInterval(() => {
         void this.runCycle().catch(error => {
            logger.error({ err: error }, 'Order keeper cycle failed');
         });
      }, this.intervalMs);

      if (
         typeof (this.timer as unknown as { unref?: () => void }).unref ===
         'function'
      ) {
         (this.timer as unknown as { unref: () => void }).unref();
      }

      logger.info(
         { intervalMs: this.intervalMs },
         'Order keeper worker started'
      );
   }

   stop(): void {
      if (!this.timer) {
         return;
      }
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Order keeper worker stopped');
   }

   async runCycle(): Promise<void> {
      if (this.cycleInFlight) {
         logger.warn(
            'Order keeper cycle skipped: previous cycle is still running'
         );
         return;
      }

      this.cycleInFlight = true;
      try {
         await this.processOpenOrders();
      } finally {
         this.cycleInFlight = false;
      }
   }

   private async processOpenOrders(): Promise<void> {
      let cursor: OrderCursor | undefined;
      let sequence: bigint | undefined;
      const now = this.now();

      for (;;) {
         const orders = await loadOrderPage(cursor);
         if (orders.length === 0) {
            return;
         }

         const keyIds = [...new Set(orders.map(order => order.keyId))];
         const snapshots = (await prisma.creatorPriceSnapshot.findMany({
            where: { creatorId: { in: keyIds } },
            select: { creatorId: true, currentPrice: true },
         })) as PriceSnapshot[];
         const prices = new Map(
            snapshots.map(snapshot => [
               snapshot.creatorId,
               BigInt(snapshot.currentPrice.toString()),
            ])
         );

         for (const order of orders) {
            const price = prices.get(order.keyId);

            if (order.expiresAt && order.expiresAt.getTime() <= now.getTime()) {
               await this.updateOrderStatus(order, 'EXPIRED');
               this.skip(order, 'expired');
               continue;
            }

            let status: KeeperOrderStatus;
            try {
               status = await this.client.getOrderStatus(order.id);
            } catch (error) {
               logger.error(
                  { err: error, order_id: order.id },
                  'Order keeper could not read escrow order status'
               );
               this.skip(order, 'status_check_failed');
               continue;
            }

            if (status !== 'OPEN') {
               await this.updateOrderStatus(order, status);
               this.skip(order, status.toLowerCase());
               continue;
            }

            if (price === undefined) {
               this.skip(order, 'price_unavailable');
               continue;
            }

            if (!isOrderSide(order.side)) {
               this.skip(order, 'invalid_side');
               continue;
            }

            if (!meetsPriceCondition(order, price)) {
               this.skip(order, 'price_condition_not_met');
               continue;
            }

            let simulation: {
               keeperRewardStroops: bigint;
               estimatedFeeStroops: bigint;
            };
            try {
               simulation = await this.client.simulateFill(order);
            } catch (error) {
               logger.error(
                  { err: error, order_id: order.id },
                  'Order keeper fill simulation failed'
               );
               this.skip(order, 'simulation_failed');
               continue;
            }

            if (
               !isProfitable(
                  simulation.keeperRewardStroops,
                  simulation.estimatedFeeStroops,
                  this.profitMarginBps
               )
            ) {
               this.skip(order, 'unprofitable');
               continue;
            }

            try {
               sequence ??= BigInt(await this.client.getSequence());
               try {
                  await this.client.fillOrder(order, sequence.toString());
               } catch (error) {
                  if (!isBadSequenceError(error)) {
                     throw error;
                  }
                  sequence = BigInt(await this.client.getSequence());
                  await this.client.fillOrder(order, sequence.toString());
               }
               sequence += 1n;
            } catch (error) {
               logger.error(
                  { err: error, order_id: order.id },
                  'Order keeper fill submission failed'
               );
               this.skip(order, 'submission_failed');
               continue;
            }

            recordKeeperFill();
            logger.info(
               { order_id: order.id, key_id: order.keyId },
               'Limit order filled by keeper'
            );
            try {
               await this.updateOrderStatus(order, 'FILLED');
            } catch (error) {
               logger.error(
                  { err: error, order_id: order.id },
                  'Failed to persist filled order status'
               );
            }
         }

         if (orders.length < ORDER_KEEPER_PAGE_SIZE) {
            return;
         }
         const lastOrder = orders[orders.length - 1];
         cursor = { createdAt: lastOrder.createdAt, id: lastOrder.id };
      }
   }

   private async updateOrderStatus(
      order: KeeperOrder,
      status: Exclude<KeeperOrderStatus, 'OPEN'>
   ): Promise<void> {
      await prisma.limitOrder.updateMany({
         where: {
            id: order.id,
            status: { in: ['OPEN', 'EXECUTABLE'] },
         },
         data: { status },
      });
   }

   private skip(order: KeeperOrder, reason: string): void {
      recordKeeperSkipped();
      logger.info(
         { order_id: order.id, key_id: order.keyId, reason },
         'Limit order skipped by keeper'
      );
   }
}

let orderKeeperWorker: OrderKeeperWorker | null = null;

/** Start the keeper with the configured escrow/signing client adapter. */
export function startOrderKeeperWorker(client: OrderKeeperClient): void {
   if (orderKeeperWorker) {
      logger.warn('Order keeper worker is already running');
      return;
   }
   orderKeeperWorker = new OrderKeeperWorker(client);
   orderKeeperWorker.start();
}

export function stopOrderKeeperWorker(): void {
   orderKeeperWorker?.stop();
   orderKeeperWorker = null;
}
