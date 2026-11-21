// src/modules/trading/slippage.service.ts
// Server-side slippage protection for buy and sell trade execution (#884).
//
// Clients submit a `max_price` on buys and a `min_price` on sells. Before a
// trade executes, the submitted bound is compared against the current
// bonding-curve price. Violations are rejected with 409 and a body that
// carries `current_price` and `slippage_exceeded: true` so the client can
// requote. Every rejection is logged with wallet and key context.

import type { Response } from 'express';
import { logger } from '../../utils/logger.utils';
import {
   buildErrorResponse,
   ErrorCode,
} from '../../utils/api-response.utils';

export type TradeSide = 'buy' | 'sell';

/** Error thrown when the submitted price bound is violated. */
export class SlippageExceededError extends Error {
   constructor(
      public readonly side: TradeSide,
      public readonly currentPrice: string,
      public readonly submittedPrice: string,
      message?: string
   ) {
      super(
         message ??
            `Slippage exceeded: current price ${currentPrice} violates submitted ${
               side === 'buy' ? 'max_price' : 'min_price'
            } ${submittedPrice}`
      );
      this.name = 'SlippageExceededError';
   }
}

/** Buy passes when the current price does not exceed the submitted max. */
export function isBuyWithinSlippage(
   maxPrice: bigint,
   currentPrice: bigint
): boolean {
   return currentPrice <= maxPrice;
}

/** Sell passes when the current price is not below the submitted min. */
export function isSellWithinSlippage(
   minPrice: bigint,
   currentPrice: bigint
): boolean {
   return currentPrice >= minPrice;
}

export interface SlippageRejectionContext {
   side: TradeSide;
   wallet: string;
   keyId: string;
   currentPrice: string;
   submittedPrice: string;
   unit?: string;
   requestId?: string;
}

/**
 * Record a slippage rejection for monitoring. Includes wallet and key
 * context as required by the issue's acceptance criteria.
 */
export function logSlippageRejection(ctx: SlippageRejectionContext): void {
   logger.warn(
      {
         type: 'slippage_rejected',
         event: 'slippage_rejected',
         side: ctx.side,
         wallet: ctx.wallet,
         keyId: ctx.keyId,
         current_price: ctx.currentPrice,
         submitted_price: ctx.submittedPrice,
         unit: ctx.unit ?? 'stroops',
         ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
      },
      'Slippage rejection'
   );
}

export interface SlippageRejectionResponse {
   side: TradeSide;
   currentPrice: string;
   submittedPrice?: string;
   unit?: string;
}

/**
 * Send the 409 slippage rejection body. Extends the standard error envelope
 * with top-level `current_price` and `slippage_exceeded` flags for client
 * requote feedback.
 */
export function sendSlippageExceeded(
   res: Response,
   ctx: SlippageRejectionResponse
): void {
   const message =
      ctx.side === 'buy'
         ? 'Current price exceeds submitted max_price'
         : 'Current price is below submitted min_price';
   const body = {
      ...buildErrorResponse(ErrorCode.SLIPPAGE_EXCEEDED, message),
      current_price: ctx.currentPrice,
      slippage_exceeded: true as const,
      ...(ctx.submittedPrice !== undefined
         ? { submitted_price: ctx.submittedPrice }
         : {}),
      ...(ctx.unit !== undefined ? { unit: ctx.unit } : {}),
   };
   if (typeof res.setHeader === 'function') {
      res.setHeader('Content-Type', 'application/json');
   }
   res.status(409).json(body);
}
