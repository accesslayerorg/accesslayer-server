// src/modules/trade/trade.routes.ts
// Route wiring for key buy/sell with idempotency support.

import { Router } from 'express';
import { requireWalletAuth } from '../../middlewares/auth-wallet.middleware';
import { idempotencyMiddleware } from '../../middlewares/idempotency.middleware';
import { httpBuyKey, httpSellKey } from './trade.controller';

const tradeRouter = Router();

/**
 * POST /trade/buy
 *
 * Executes a buy for the authenticated wallet. The `X-Idempotency-Key` header
 * is required; duplicate requests with the same key (and wallet) return the
 * cached response without re-executing the transaction (24h TTL).
 */
tradeRouter.post(
   '/trade/buy',
   requireWalletAuth,
   idempotencyMiddleware(),
   httpBuyKey
);

/**
 * POST /trade/sell
 *
 * Executes a sell for the authenticated wallet with the same idempotency
 * guarantees as the buy endpoint.
 */
tradeRouter.post(
   '/trade/sell',
   requireWalletAuth,
   idempotencyMiddleware(),
   httpSellKey
);

export default tradeRouter;
