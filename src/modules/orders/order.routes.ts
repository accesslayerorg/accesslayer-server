import { Router } from 'express';
import { requireJwtAuth } from '../../middlewares/jwt-auth.middleware';
import {
   httpCancelOrder,
   httpCreateOrder,
   httpListOrders,
} from './order.controllers';

const ordersRouter = Router();

// Every order route is scoped to the authenticated wallet.
ordersRouter.use(requireJwtAuth);

/**
 * POST /api/v1/orders
 * Place a limit order for the authenticated wallet.
 */
ordersRouter.post('/', httpCreateOrder);

/**
 * GET /api/v1/orders?wallet=...
 * List the authenticated wallet's limit orders.
 */
ordersRouter.get('/', httpListOrders);

/**
 * DELETE /api/v1/orders/:id
 * Cancel an order (owner only).
 */
ordersRouter.delete('/:id', httpCancelOrder);

export default ordersRouter;
