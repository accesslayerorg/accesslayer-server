import { NextFunction, Request, Response, Router } from 'express';
import { requireKeyCreator } from '../../middlewares/jwt-auth.middleware';
import {
   httpAddToWhitelist,
   httpCheckWhitelistBulk,
   httpGetWhitelistStatus,
   httpListWhitelist,
   httpRemoveFromWhitelist,
} from './whitelist.controllers';

const whitelistRouter = Router();

const normalizeKeyId = (req: Request, _res: Response, next: NextFunction) => {
   if (!req.params.keyId && req.params.key_id) {
      req.params.keyId = req.params.key_id;
   }
   next();
};

/**
 * POST /keys/:key_id/whitelist/check
 * (also /keys/:keyId/whitelist/check)
 * Public bulk check endpoint: checks whitelist status for wallets[]
 */
whitelistRouter.post(
   ['/:key_id/whitelist/check', '/:keyId/whitelist/check'],
   normalizeKeyId,
   httpCheckWhitelistBulk
);

/**
 * GET /keys/:key_id/whitelist/:wallet
 * (also /keys/:keyId/whitelist/:wallet)
 * Public endpoint - returns whitelist and wallet approval status.
 */
whitelistRouter.get(
   ['/:key_id/whitelist/:wallet', '/:keyId/whitelist/:wallet'],
   normalizeKeyId,
   httpGetWhitelistStatus
);

/**
 * GET /keys/:keyId/whitelist?wallet=<address>
 * Public endpoint - no authentication required
 * Returns whitelist status and wallet approval status
 *
 * Without `wallet`, falls through to the creator-only list below.
 */
whitelistRouter.get(
   ['/:key_id/whitelist', '/:keyId/whitelist'],
   normalizeKeyId,
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
   ['/:key_id/whitelist', '/:keyId/whitelist'],
   normalizeKeyId,
   requireKeyCreator('keyId'),
   httpListWhitelist
);

/**
 * POST /keys/:keyId/whitelist
 * Creator-only (JWT). Bulk-adds wallets: { wallets: string[] }.
 */
whitelistRouter.post(
   ['/:key_id/whitelist', '/:keyId/whitelist'],
   normalizeKeyId,
   requireKeyCreator('keyId'),
   httpAddToWhitelist
);

/**
 * DELETE /keys/:keyId/whitelist/:wallet
 * Creator-only (JWT). Removes a wallet from the whitelist.
 */
whitelistRouter.delete(
   ['/:key_id/whitelist/:wallet', '/:keyId/whitelist/:wallet'],
   normalizeKeyId,
   requireKeyCreator('keyId'),
   httpRemoveFromWhitelist
);

export default whitelistRouter;
