// src/modules/bounties/bounty.routes.ts
// Bounty board and creator bounty management endpoints (#1307).

import { Router } from 'express';
import { z } from 'zod';
import {
   sendNotFound,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { BountyNotFoundError, bountyService } from './bounty.service';

export const bountiesRouter = Router();
export const creatorBountiesRouter = Router();

const ListBountiesQuerySchema = z.object({
   keyId: z.string().trim().min(1).optional(),
   status: z.enum(['open', 'expired', 'completed', 'reclaimed']).optional(),
   minReward: z
      .string()
      .regex(/^\d+$/, 'minReward must be a non-negative integer')
      .optional(),
   cursor: z.string().trim().min(1).optional(),
   limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * GET /v1/bounties?keyId=&status=&minReward=&cursor=
 */
bountiesRouter.get('/', async (req, res, next) => {
   const parsed = ListBountiesQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid bounty query parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const result = await bountyService.listBounties({
         keyId: parsed.data.keyId,
         status: parsed.data.status,
         minReward:
            parsed.data.minReward !== undefined
               ? BigInt(parsed.data.minReward)
               : undefined,
         cursor: parsed.data.cursor,
         limit: parsed.data.limit,
      });
      sendSuccess(res, result);
   } catch (error) {
      next(error);
   }
});

/**
 * GET /v1/bounties/:id
 */
bountiesRouter.get('/:id', async (req, res, next) => {
   try {
      const detail = await bountyService.getBountyDetail(String(req.params.id));
      sendSuccess(res, detail);
   } catch (error) {
      if (error instanceof BountyNotFoundError) {
         sendNotFound(res, 'Bounty');
         return;
      }
      next(error);
   }
});

/**
 * GET /v1/creators/:handle/bounties
 */
creatorBountiesRouter.get('/:handle/bounties', async (req, res, next) => {
   try {
      const result = await bountyService.listCreatorBounties(
         String(req.params.handle)
      );
      sendSuccess(res, result);
   } catch (error) {
      next(error);
   }
});
