// src/modules/keys/cooldown.routes.ts
// Batch cooldown status route (#968).

import { Router } from 'express';
import { z } from 'zod';
import { StellarAddressSchema } from '../wallet/wallet.schemas';
import { parseCommaQuery } from '../../utils/comma-query.utils';
import { sendSuccess, sendValidationError, zodIssuesToDetails } from '../../utils/api-response.utils';
import { getBatchCooldowns } from './key-cooldown.service';

const router = Router();

const batchCooldownQuerySchema = z.object({
   wallet: StellarAddressSchema,
   keys: z.string().min(1, 'Keys parameter is required'),
});

/**
 * GET /api/v1/cooldowns?wallet=&keys=
 * Batch cooldown status for up to 50 key IDs.
 */
router.get('/', async (req, res, next) => {
   const parsed = batchCooldownQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid query parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   const keyIds = parseCommaQuery(parsed.data.keys);
   if (keyIds.length === 0) {
      sendValidationError(res, 'At least one key ID is required in keys parameter');
      return;
   }
   if (keyIds.length > 50) {
      sendValidationError(res, 'Batch request exceeds maximum of 50 key IDs');
      return;
   }

   try {
      const results = await getBatchCooldowns(keyIds, parsed.data.wallet);
      sendSuccess(res, results);
   } catch (error) {
      next(error);
   }
});

router.all('/', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

export default router;
