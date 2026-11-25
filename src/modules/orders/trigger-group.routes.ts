// src/modules/orders/trigger-group.routes.ts
import { randomUUID } from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import {
   sendError,
   sendSuccess,
   sendValidationError,
} from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import {
   InvalidTriggerError,
   cancelTriggerGroup,
   createTriggerGroup,
   listActiveTriggers,
} from './trigger-group.service';

const triggerRouter = Router();

const createSchema = z.object({
   wallet: z.string().min(1),
   keyId: z.string().min(1),
   totalAmount: z.string(),
   currentPrice: z.string(),
   takeProfitPrice: z.string(),
   stopLossPrice: z.string(),
   walletBalance: z.string(),
});

/**
 * POST /api/v1/triggers
 * Create a linked take-profit / stop-loss trigger group (#1352).
 *
 * The two legs are OCO — one firing cancels the other in the same tx.
 */
triggerRouter.post('/', async (req, res, next) => {
   try {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
         return sendValidationError(res, 'Invalid trigger body');
      }
      const body = parsed.data;
      try {
         const group = await createTriggerGroup({
            id: randomUUID(),
            takeProfitLegId: randomUUID(),
            stopLossLegId: randomUUID(),
            wallet: body.wallet,
            keyId: body.keyId,
            totalAmount: BigInt(body.totalAmount),
            currentPrice: BigInt(body.currentPrice),
            takeProfitPrice: BigInt(body.takeProfitPrice),
            stopLossPrice: BigInt(body.stopLossPrice),
            walletBalance: BigInt(body.walletBalance),
         });
         return sendSuccess(res, group, 201);
      } catch (err) {
         if (err instanceof InvalidTriggerError) {
            return sendError(res, 400, ErrorCode.VALIDATION_ERROR, err.message);
         }
         throw err;
      }
   } catch (error) { next(error); }
});

/**
 * PATCH /api/v1/triggers/:groupId
 * Replace trigger prices on the group's legs (#1352). The atomic pattern
 * here is: cancel, then create a new group — so the handler takes the
 * same body as POST and chains the two calls.
 */
triggerRouter.patch('/:groupId', async (req, res, next) => {
   try {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) {
         return sendValidationError(res, 'Invalid trigger body');
      }
      await cancelTriggerGroup(String(req.params.groupId));
      const body = parsed.data;
      try {
         const group = await createTriggerGroup({
            id: randomUUID(),
            takeProfitLegId: randomUUID(),
            stopLossLegId: randomUUID(),
            wallet: body.wallet,
            keyId: body.keyId,
            totalAmount: BigInt(body.totalAmount),
            currentPrice: BigInt(body.currentPrice),
            takeProfitPrice: BigInt(body.takeProfitPrice),
            stopLossPrice: BigInt(body.stopLossPrice),
            walletBalance: BigInt(body.walletBalance),
         });
         return sendSuccess(res, group);
      } catch (err) {
         if (err instanceof InvalidTriggerError) {
            return sendError(res, 400, ErrorCode.VALIDATION_ERROR, err.message);
         }
         throw err;
      }
   } catch (error) { next(error); }
});

/**
 * DELETE /api/v1/triggers/:groupId
 * Cancel both legs atomically (#1352).
 */
triggerRouter.delete('/:groupId', async (req, res, next) => {
   try {
      await cancelTriggerGroup(String(req.params.groupId));
      return sendSuccess(res, { groupId: String(req.params.groupId), status: 'cancelled' });
   } catch (error) { next(error); }
});

/**
 * GET /api/v1/triggers?wallet=
 * List active trigger groups for a wallet (#1352).
 */
triggerRouter.get('/', async (req, res, next) => {
   try {
      const wallet = typeof req.query.wallet === 'string' ? req.query.wallet : undefined;
      return sendSuccess(res, await listActiveTriggers(wallet));
   } catch (error) { next(error); }
});

export default triggerRouter;
