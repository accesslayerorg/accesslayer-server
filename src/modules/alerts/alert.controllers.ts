import { Request, Response, NextFunction } from 'express';
import { CreateAlertSchema } from './alert.schemas';
import {
   createAlert,
   listAlerts,
   deleteAlert,
   triggerAlert,
} from './alert.service';
import {
   sendSuccess,
   sendValidationError,
   sendNotFound,
   sendError,
   ErrorCode,
} from '../../utils/api-response.utils';
import { AuthenticatedRequest } from '../../middlewares/jwt-auth.middleware';

/**
 * POST /api/v1/alerts
 * Register a new price alert for the authenticated wallet.
 */
export async function httpCreateAlert(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const authWallet = (req as AuthenticatedRequest).user?.wallet;
      const payload = {
         ...req.body,
         wallet_address: authWallet || req.body?.wallet_address || req.body?.walletAddress,
      };

      const parsed = CreateAlertSchema.safeParse(payload);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid alert input',
            parsed.error.issues.map(
               (issue: { path: (string | number)[]; message: string }) => ({
                  field: issue.path.join('.'),
                  message: issue.message,
               })
            )
         );
         return;
      }

      if (!parsed.data.wallet_address) {
         sendValidationError(res, 'Invalid alert input', [
            { field: 'wallet_address', message: 'wallet_address is required' },
         ]);
         return;
      }

      const alert = await createAlert(parsed.data as any);
      sendSuccess(res, alert, 201);
   } catch (error: any) {
      if (error?.statusCode === 409 || error?.code === 'DUPLICATE_ALERT') {
         sendError(res, 409, ErrorCode.CONFLICT, error.message);
         return;
      }
      next(error);
   }
}

/**
 * GET /api/v1/alerts?wallet_address=...
 * List all active price alerts for the authenticated wallet address.
 */
export async function httpListAlerts(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const authWallet = (req as AuthenticatedRequest).user?.wallet;
      const queryWallet = req.query.wallet_address || req.query.walletAddress;
      const targetWallet = authWallet || queryWallet;

      if (!targetWallet || typeof targetWallet !== 'string') {
         sendValidationError(res, 'Invalid query parameters', [
            {
               field: 'wallet_address',
               message: 'wallet_address is required',
            },
         ]);
         return;
      }

      const alerts = await listAlerts(targetWallet);
      sendSuccess(res, { items: alerts, total: alerts.length });
   } catch (error) {
      next(error);
   }
}

/**
 * PATCH /api/v1/alerts/:alertId/triggered
 * Mark a price alert as triggered (owner only).
 */
export async function httpTriggerAlert(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const alertId = (req.params.alertId || req.params.id) as string;
      if (!alertId) {
         sendValidationError(res, 'Invalid alert id', [
            { field: 'alertId', message: 'Alert id is required' },
         ]);
         return;
      }

      const authWallet = (req as AuthenticatedRequest).user?.wallet;
      const result = await triggerAlert(alertId, authWallet);

      if (!result) {
         sendNotFound(res, 'Alert');
         return;
      }

      sendSuccess(res, result);
   } catch (error: any) {
      if (error?.statusCode === 403 || error?.code === 'FORBIDDEN') {
         sendError(res, 403, ErrorCode.FORBIDDEN, error.message);
         return;
      }
      next(error);
   }
}

/**
 * DELETE /api/v1/alerts/:id
 * Delete a price alert by id (owner only).
 */
export async function httpDeleteAlert(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const alertId = (req.params.alertId || req.params.id) as string;
      if (!alertId) {
         sendValidationError(res, 'Invalid alert id', [
            { field: 'id', message: 'Alert id is required' },
         ]);
         return;
      }

      const authWallet =
         (req as AuthenticatedRequest).user?.wallet ||
         req.body?.wallet_address ||
         req.body?.walletAddress;

      const result = await deleteAlert(alertId, authWallet);

      if (!result) {
         sendNotFound(res, 'Alert');
         return;
      }

      sendSuccess(res, result);
   } catch (error: any) {
      if (error?.statusCode === 403 || error?.code === 'FORBIDDEN') {
         sendError(res, 403, ErrorCode.FORBIDDEN, error.message);
         return;
      }
      next(error);
   }
}
