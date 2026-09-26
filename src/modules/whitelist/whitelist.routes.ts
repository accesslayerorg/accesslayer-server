import { NextFunction, Request, Response, Router } from 'express';
import { requireKeyCreator } from '../../middlewares/jwt-auth.middleware';
import {
   httpAddToWhitelist,
   httpGetWhitelistStatus,
   httpListWhitelist,
   httpRemoveFromWhitelist,
} from './whitelist.controllers';

const whitelistRouter = Router();

/**
 * GET /keys/:keyId/whitelist?wallet=<address>
 * Public endpoint - no authentication required
 * Returns whitelist status and wallet approval status
 *
 * Without `wallet`, falls through to the creator-only list below.
 */
whitelistRouter.get(
   '/:keyId/whitelist',
   (req: Request, res: Response, next: NextFunction) => {
      if (req.query.wallet === undefined) {
         return next();
      }
      return httpGetWhitelistStatus(req, res, next);
   }
);

/**
 * GET /keys/:keyId/whitelist
 * Creator-only (JWT). Returns the synced whitelist for the key.
 */
whitelistRouter.get(
   '/:keyId/whitelist',
   requireKeyCreator('keyId'),
   httpListWhitelist
);

/**
 * POST /keys/:keyId/whitelist
 * Creator-only (JWT). Bulk-adds wallets: { wallets: string[] }.
 */
whitelistRouter.post(
   '/:keyId/whitelist',
   requireKeyCreator('keyId'),
   httpAddToWhitelist
);

/**
 * DELETE /keys/:keyId/whitelist/:wallet
 * Creator-only (JWT). Removes a wallet from the whitelist.
 */
whitelistRouter.delete(
   '/:keyId/whitelist/:wallet',
   requireKeyCreator('keyId'),
   httpRemoveFromWhitelist
);

export default whitelistRouter;
