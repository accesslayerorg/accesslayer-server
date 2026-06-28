import { Router } from 'express';
import { httpCreateAlert, httpListAlerts, httpDeleteAlert } from './alert.controllers';

const alertsRouter = Router();

/**
 * POST /api/v1/alerts
 * Register a new price alert for a creator key price threshold.
 */
alertsRouter.post('/', httpCreateAlert);

/**
 * GET /api/v1/alerts?wallet_address=...
 * List all active price alerts for the given Stellar wallet address.
 */
alertsRouter.get('/', httpListAlerts);

/**
 * DELETE /api/v1/alerts/:id
 * Delete a price alert by id (wallet_address required in body for authorization).
 */
alertsRouter.delete('/:id', httpDeleteAlert);

export default alertsRouter;
