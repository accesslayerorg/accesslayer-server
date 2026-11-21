import { Router } from 'express';
import { requireJwtAuth } from '../../middlewares/jwt-auth.middleware';
import { httpCreateOrder } from './orders.controllers';

const ordersRouter = Router();

/**
 * POST /v1/orders
 * POST /api/v1/orders
 *
 * Places a buy or sell order for creator keys. Requires authenticated wallet session.
 */
ordersRouter.post('/', requireJwtAuth, httpCreateOrder);

export default ordersRouter;
