// src/modules/investor/watchlist.routes.ts
import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
   requireJwtAuth,
   AuthenticatedRequest,
} from '../../middlewares/jwt-auth.middleware';
import {
   sendSuccess,
   sendNotFound,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   addToWatchlist,
   removeFromWatchlist,
   getWatchlist,
   InvoiceNotFoundError,
   WatchlistNotFoundError,
} from './watchlist.service';

const router = Router();

// All watchlist routes require wallet JWT authentication
router.use(requireJwtAuth);

const watchlistParamsSchema = z.object({
   invoice_id: z.string().min(1, 'invoice_id parameter is required'),
});

/**
 * GET /watchlist
 * Returns all watched invoices for the authenticated wallet with current status
 * and last_seen timestamp, updating last_seen on each GET.
 */
router.get(
   '/',
   async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      try {
         const walletAddress = req.user!.wallet;
         const items = await getWatchlist(walletAddress);
         sendSuccess(res, items);
      } catch (error) {
         next(error);
      }
   }
);

/**
 * POST /watchlist/:invoice_id
 * Adds invoice to the authenticated wallet's watchlist.
 */
router.post(
   '/:invoice_id',
   async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      const params = watchlistParamsSchema.safeParse(req.params);
      if (!params.success) {
         sendValidationError(
            res,
            'Invalid path parameters',
            zodIssuesToDetails(params.error.issues)
         );
         return;
      }

      try {
         const walletAddress = req.user!.wallet;
         const entry = await addToWatchlist(
            walletAddress,
            params.data.invoice_id
         );
         sendSuccess(res, entry, 201, 'Invoice added to watchlist');
      } catch (error) {
         if (error instanceof InvoiceNotFoundError) {
            sendNotFound(res, 'Invoice');
            return;
         }
         next(error);
      }
   }
);

/**
 * DELETE /watchlist/:invoice_id
 * Removes invoice from the authenticated wallet's watchlist.
 */
router.delete(
   '/:invoice_id',
   async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      const params = watchlistParamsSchema.safeParse(req.params);
      if (!params.success) {
         sendValidationError(
            res,
            'Invalid path parameters',
            zodIssuesToDetails(params.error.issues)
         );
         return;
      }

      try {
         const walletAddress = req.user!.wallet;
         const result = await removeFromWatchlist(
            walletAddress,
            params.data.invoice_id
         );
         sendSuccess(res, result, 200, 'Invoice removed from watchlist');
      } catch (error) {
         if (error instanceof WatchlistNotFoundError) {
            sendNotFound(res, 'Watchlist entry');
            return;
         }
         next(error);
      }
   }
);

export default router;
