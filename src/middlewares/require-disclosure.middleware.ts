import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './jwt-auth.middleware';
import { checkDisclosureStatus } from '../modules/disclosures/disclosures.service';

/**
 * Middleware for trade-preparing endpoints (#1318).
 * Returns 428 Precondition Required with `requiredVersion` when an active
 * risk disclosure exists and the wallet has not accepted it yet.
 */
export function requireDisclosure() {
   return async (
      req: AuthenticatedRequest,
      res: Response,
      next: NextFunction
   ): Promise<void> => {
      try {
         const wallet =
            req.user?.wallet ??
            (typeof req.body?.wallet === 'string' ? req.body.wallet : undefined) ??
            (typeof req.query?.wallet === 'string'
               ? req.query.wallet
               : undefined);

         const status = await checkDisclosureStatus(wallet);
         if (status.required && !status.accepted && status.currentVersion) {
            res.status(428).json({
               success: false,
               error: {
                  code: 'DISCLOSURE_REQUIRED',
                  message:
                     'Risk disclosure acknowledgement is required before trading.',
               },
               requiredVersion: {
                  id: status.currentVersion.id,
                  version: status.currentVersion.version,
                  textHash: status.currentVersion.textHash,
                  contentUrl: status.currentVersion.contentUrl,
               },
            });
            return;
         }

         next();
      } catch (error) {
         next(error);
      }
   };
}
