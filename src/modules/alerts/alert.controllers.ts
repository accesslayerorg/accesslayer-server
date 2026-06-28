import { Request, Response, NextFunction } from 'express';
import {
    CreateAlertSchema,
    ListAlertsQuerySchema,
    AlertParamsSchema,
    DeleteAlertBodySchema,
} from './alert.schemas';
import { createAlert, listAlerts, deleteAlert } from './alert.service';
import {
    sendSuccess,
    sendValidationError,
    sendNotFound,
} from '../../utils/api-response.utils';

/**
 * POST /api/v1/alerts
 * Register a new price alert.
 */
export async function httpCreateAlert(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const parsed = CreateAlertSchema.safeParse(req.body);
        if (!parsed.success) {
            sendValidationError(
                res,
                'Invalid alert input',
                parsed.error.issues.map((issue: { path: (string | number)[]; message: string }) => ({
                    field: issue.path.join('.'),
                    message: issue.message,
                }))
            );
            return;
        }

        const alert = await createAlert(parsed.data);
        sendSuccess(res, alert, 201);
    } catch (error) {
        next(error);
    }
}

/**
 * GET /api/v1/alerts?wallet_address=...
 * List all active price alerts for a wallet address.
 */
export async function httpListAlerts(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const parsed = ListAlertsQuerySchema.safeParse(req.query);
        if (!parsed.success) {
            sendValidationError(
                res,
                'Invalid query parameters',
                parsed.error.issues.map((issue: { path: (string | number)[]; message: string }) => ({
                    field: issue.path.join('.'),
                    message: issue.message,
                }))
            );
            return;
        }

        const alerts = await listAlerts(parsed.data.wallet_address);
        sendSuccess(res, { items: alerts, total: alerts.length });
    } catch (error) {
        next(error);
    }
}

/**
 * DELETE /api/v1/alerts/:id
 * Delete a price alert by id, scoped to the wallet address in the request body.
 */
export async function httpDeleteAlert(
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> {
    try {
        const parsedParams = AlertParamsSchema.safeParse(req.params);
        if (!parsedParams.success) {
            sendValidationError(
                res,
                'Invalid alert id',
                parsedParams.error.issues.map((issue: { path: (string | number)[]; message: string }) => ({
                    field: issue.path.join('.'),
                    message: issue.message,
                }))
            );
            return;
        }

        const parsedBody = DeleteAlertBodySchema.safeParse(req.body);
        if (!parsedBody.success) {
            sendValidationError(
                res,
                'Invalid request body',
                parsedBody.error.issues.map((issue: { path: (string | number)[]; message: string }) => ({
                    field: issue.path.join('.'),
                    message: issue.message,
                }))
            );
            return;
        }

        const result = await deleteAlert(parsedParams.data.id, parsedBody.data.wallet_address);

        if (!result) {
            sendNotFound(res, 'Alert');
            return;
        }

        sendSuccess(res, result);
    } catch (error) {
        next(error);
    }
}
