// src/modules/spotlight/spotlight.routes.ts
//
// Spotlight auction REST endpoints (#1114).

import { Router } from 'express';
import { sendSuccess } from '../../utils/api-response.utils';
import { logger } from '../../utils/logger.utils';
import {
   getActiveSpotlight,
   getSpotlightBidsForSlot,
} from './spotlight.service';

const router = Router();

/**
 * GET /spotlight/active
 * Returns current winning key, remaining duration, and winning bid.
 */
router.get('/active', async (_req, res, next) => {
   try {
      const active = await getActiveSpotlight();
      sendSuccess(res, active, 200);
   } catch (error) {
      logger.error({ error }, 'Get active spotlight failed');
      next(error);
   }
});

router.all('/active', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

/**
 * GET /spotlight/bids/:slot_id
 * Returns all bids for a slot in descending order.
 */
router.get('/bids/:slot_id', async (req, res, next) => {
   try {
      const slotId = String(req.params.slot_id);
      const bids = await getSpotlightBidsForSlot(slotId);
      sendSuccess(res, bids, 200);
   } catch (error) {
      logger.error({ error, slotId: req.params.slot_id }, 'Get spotlight bids failed');
      next(error);
   }
});

router.all('/bids/:slot_id', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

export default router;
