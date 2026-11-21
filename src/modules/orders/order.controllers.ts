import { Request, Response, NextFunction } from 'express';
import {
   ErrorCode,
   sendError,
   sendNotFound,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { AuthenticatedRequest } from '../../middlewares/jwt-auth.middleware';
import { CreateOrderSchema } from './order.schemas';
import {
   cancelLimitOrder,
   createLimitOrder,
   listLimitOrders,
   OrderServiceError,
} from './order.service';

/** Maps a thrown order error to its response, or defers to the error handler. */
function handleOrderError(
   error: unknown,
   res: Response,
   next: NextFunction
): void {
   if (error instanceof OrderServiceError) {
      sendError(res, error.statusCode, error.code, error.message);
      return;
   }
   next(error);
}

/**
 * POST /api/v1/orders
 * Place a limit order for the authenticated wallet.
 */
export async function httpCreateOrder(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const wallet = (req as AuthenticatedRequest).user?.wallet;
      if (!wallet) {
         sendError(
            res,
            401,
            ErrorCode.UNAUTHORIZED,
            'Authentication required'
         );
         return;
      }

      const parsed = CreateOrderSchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid order input',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      const order = await createLimitOrder(wallet, parsed.data);
      sendSuccess(res, order, 201);
   } catch (error) {
      handleOrderError(error, res, next);
   }
}

/**
 * GET /api/v1/orders?wallet=...
 * List the authenticated wallet's orders.
 */
export async function httpListOrders(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const wallet = (req as AuthenticatedRequest).user?.wallet;
      if (!wallet) {
         sendError(
            res,
            401,
            ErrorCode.UNAUTHORIZED,
            'Authentication required'
         );
         return;
      }

      const queryWallet =
         typeof req.query.wallet === 'string' ? req.query.wallet : undefined;

      if (queryWallet && queryWallet !== wallet) {
         sendError(
            res,
            403,
            ErrorCode.FORBIDDEN,
            'You do not have permission to view orders for another wallet'
         );
         return;
      }

      const orders = await listLimitOrders(wallet);
      sendSuccess(res, { items: orders, total: orders.length });
   } catch (error) {
      next(error);
   }
}

/**
 * DELETE /api/v1/orders/:id
 * Cancel an order. Only the owner may cancel it.
 */
export async function httpCancelOrder(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const wallet = (req as AuthenticatedRequest).user?.wallet;
      if (!wallet) {
         sendError(
            res,
            401,
            ErrorCode.UNAUTHORIZED,
            'Authentication required'
         );
         return;
      }

      // The route only matches with a non-empty id, so no extra validation.
      const result = await cancelLimitOrder(req.params.id as string, wallet);
      if (!result) {
         sendNotFound(res, 'Order');
         return;
      }

      sendSuccess(res, result);
   } catch (error) {
      handleOrderError(error, res, next);
   }
}
