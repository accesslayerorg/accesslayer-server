// src/modules/orders/order-events.utils.ts
// Internal event bus for limit order lifecycle events (#1220).
//
// The order matcher emits `order.executable` after a page commits so
// downstream consumers (notifications, SSE fan-out) can react without polling
// the database. Emission failures are logged but never propagate — events are
// advisory, not critical path.

import { EventEmitter } from 'events';
import { logger } from '../../utils/logger.utils';
import type { OrderSide } from './order.schemas';

const EXECUTABLE_EVENT = 'order.executable';

const eventEmitter = new EventEmitter();
eventEmitter.setMaxListeners(50);

export interface OrderExecutableEvent {
   type: typeof EXECUTABLE_EVENT;
   orderId: string;
   wallet: string;
   keyId: string;
   side: OrderSide;
   /** Target price in XLM, as a string to preserve Decimal precision. */
   targetPrice: string;
   quantity: string;
   /** Curve price at trigger time, in stroops. */
   currentPrice: string;
   triggeredAt: string;
}

/** Subscribe to `order.executable`. Returns an unsubscribe function. */
export function onOrderExecutable(
   handler: (payload: OrderExecutableEvent) => void
): () => void {
   eventEmitter.on(EXECUTABLE_EVENT, handler);
   return () => {
      eventEmitter.off(EXECUTABLE_EVENT, handler);
   };
}

/** Emit an order.executable event. Never throws. */
export function emitOrderExecutable(payload: OrderExecutableEvent): void {
   try {
      eventEmitter.emit(EXECUTABLE_EVENT, payload);
      logger.info(
         {
            event: EXECUTABLE_EVENT,
            order_id: payload.orderId,
            key_id: payload.keyId,
            side: payload.side,
            target_price: payload.targetPrice,
            current_price: payload.currentPrice,
         },
         'Limit order became executable'
      );
   } catch (error) {
      logger.error({ error }, 'Failed to emit order.executable event');
   }
}
