// src/modules/orders/order.service.ts
// Limit order creation, listing and cancellation (#1220).

import { ErrorCode, ErrorCodeType } from '../../constants/error.constants';
import { logger } from '../../utils/logger.utils';
import { prisma } from '../../utils/prisma.utils';
import type { CreateOrderInput, OrderSide } from './order.schemas';

const STROOPS_PER_XLM = 10_000_000n;

/** Error carrying the HTTP status/code the route should return. */
export class OrderServiceError extends Error {
   statusCode: number;
   code: ErrorCodeType;

   constructor(statusCode: number, code: ErrorCodeType, message: string) {
      super(message);
      this.name = 'OrderServiceError';
      this.statusCode = statusCode;
      this.code = code;
   }
}

/**
 * Convert an XLM price (up to 7 decimal places) to integer stroops.
 * String parsing keeps the conversion exact for large stroop values.
 */
export function xlmToStroops(value: number | string): bigint {
   const text = typeof value === 'number' ? value.toFixed(7) : value.trim();
   const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
   if (!match) {
      throw new Error(`Invalid XLM amount: ${text}`);
   }

   const [, sign, whole, fraction = ''] = match;
   const paddedFraction = (fraction + '0000000').slice(0, 7);
   const stroops = BigInt(whole) * STROOPS_PER_XLM + BigInt(paddedFraction);
   return sign === '-' ? -stroops : stroops;
}

/**
 * Validate a target price against the current curve price.
 *
 * A buy order may only target a price strictly below the current price and a
 * sell order only strictly above it; otherwise the order would be executable
 * the instant it was placed.
 */
function assertValidOrderTarget(
   side: OrderSide,
   targetStroops: bigint,
   currentStroops: bigint
): void {
   if (side === 'BUY' && targetStroops >= currentStroops) {
      throw new OrderServiceError(
         400,
         ErrorCode.VALIDATION_ERROR,
         'Buy target price must be below the current curve price'
      );
   }

   if (side === 'SELL' && targetStroops <= currentStroops) {
      throw new OrderServiceError(
         400,
         ErrorCode.VALIDATION_ERROR,
         'Sell target price must be above the current curve price'
      );
   }
}

/**
 * Create an OPEN limit order for the authenticated wallet.
 *
 * @throws {OrderServiceError} 400 when the key has no indexed price yet or
 * the target is on the wrong side of the current curve price.
 */
export async function createLimitOrder(
   wallet: string,
   input: CreateOrderInput
) {
   const snapshot = await prisma.creatorPriceSnapshot.findUnique({
      where: { creatorId: input.keyId },
      select: { currentPrice: true },
   });

   if (!snapshot) {
      throw new OrderServiceError(
         400,
         ErrorCode.VALIDATION_ERROR,
         'Current price is not available for this key'
      );
   }

   const currentStroops = BigInt(snapshot.currentPrice.toString());
   if (currentStroops <= 0n) {
      throw new OrderServiceError(
         400,
         ErrorCode.VALIDATION_ERROR,
         'Current price is not available for this key'
      );
   }

   assertValidOrderTarget(
      input.side,
      xlmToStroops(input.targetPrice),
      currentStroops
   );

   const order = await prisma.limitOrder.create({
      data: {
         wallet,
         keyId: input.keyId,
         side: input.side,
         targetPrice: input.targetPrice,
         quantity: input.quantity,
         status: 'OPEN',
         expiresAt: input.expiresAt ?? null,
      },
   });

   logger.info(
      {
         order_id: order.id,
         key_id: order.keyId,
         side: order.side,
         target_price: order.targetPrice.toString(),
         quantity: order.quantity.toString(),
         expires_at: order.expiresAt,
      },
      'Limit order created'
   );

   return order;
}

/** List a wallet's orders, newest first. */
export async function listLimitOrders(wallet: string) {
   return prisma.limitOrder.findMany({
      where: { wallet },
      orderBy: { createdAt: 'desc' },
   });
}

/**
 * Cancel (delete) an order. Only the owning wallet may cancel it.
 *
 * @throws {OrderServiceError} 403 when the order belongs to another wallet.
 * @returns the cancelled order id, or null when no such order exists.
 */
export async function cancelLimitOrder(
   id: string,
   wallet: string
): Promise<{ id: string } | null> {
   const existing = await prisma.limitOrder.findUnique({ where: { id } });

   if (!existing) {
      return null;
   }

   if (existing.wallet !== wallet) {
      throw new OrderServiceError(
         403,
         ErrorCode.FORBIDDEN,
         'You do not have permission to cancel this order'
      );
   }

   await prisma.limitOrder.delete({ where: { id } });

   logger.info(
      { order_id: existing.id, key_id: existing.keyId },
      'Limit order cancelled'
   );

   return { id: existing.id };
}
