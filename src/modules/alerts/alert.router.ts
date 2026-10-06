import { Router } from 'express';
import { requireJwtAuth } from '../../middlewares/jwt-auth.middleware';
import {
   httpCreateAlert,
   httpListAlerts,
   httpTriggerAlert,
   httpDeleteAlert,
} from './alert.controllers';

const alertsRouter = Router();

// Protect all alert routes with JWT authentication
alertsRouter.use(requireJwtAuth);

/**
 * POST /api/v1/alerts
 * Register a new price alert for the authenticated wallet.
 */
alertsRouter.post('/', httpCreateAlert);

/**
 * GET /api/v1/alerts
 * List all active price alerts for the authenticated wallet.
 */
alertsRouter.get('/', httpListAlerts);

/**
 * PATCH /api/v1/alerts/:alertId/triggered
 * Mark a price alert as triggered (owner only).
 */
alertsRouter.patch('/:alertId/triggered', httpTriggerAlert);
alertsRouter.patch('/:id/triggered', httpTriggerAlert);

/**
 * DELETE /api/v1/alerts/:alertId
 * Delete a price alert by id (owner only).
 */
alertsRouter.delete('/:alertId', httpDeleteAlert);
alertsRouter.delete('/:id', httpDeleteAlert);

export default alertsRouter;
