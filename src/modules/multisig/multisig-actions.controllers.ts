// src/modules/multisig/multisig-actions.controllers.ts

import { Request, Response, NextFunction } from 'express';
import { AsyncController } from '../../types/auth.types';
import { z } from 'zod';
import {
   sendSuccess,
   sendValidationError,
   sendNotFound,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   getPendingActions,
   getActionDetail,
   getActionHistory,
   MultisigActionNotFoundError,
} from './multisig-actions.service';
import { logger } from '../../utils/logger.utils';

const historyQuerySchema = z.object({
   status: z.string().optional(),
   page: z.coerce.number().int().positive().optional().default(1),
   limit: z.coerce.number().int().positive().max(100).optional().default(20),
});

export const httpGetPendingActions: AsyncController = async (
   _req: Request,
   res: Response,
   next: NextFunction
): Promise<void> => {
   try {
      const actions = await getPendingActions();
      sendSuccess(res, { actions });
   } catch (error) {
      logger.error({ error }, 'Get pending multisig actions failed');
      next(error);
   }
};

export const httpGetActionDetail: AsyncController = async (
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> => {
   try {
      const rawActionId = req.params.actionId || req.params.action_id;
      const actionId = Array.isArray(rawActionId) ? rawActionId[0] : rawActionId;

      if (!actionId || typeof actionId !== 'string' || !actionId.trim()) {
         sendValidationError(res, 'actionId parameter is required');
         return;
      }

      const action = await getActionDetail(actionId);
      sendSuccess(res, action);
   } catch (error) {
      if (error instanceof MultisigActionNotFoundError) {
         sendNotFound(res, error.message);
         return;
      }
      logger.error({ error }, 'Get multisig action detail failed');
      next(error);
   }
};

export const httpGetActionHistory: AsyncController = async (
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> => {
   try {
      const parsed = historyQuerySchema.safeParse(req.query);
      if (!parsed.success) {
         sendValidationError(res, 'Invalid query parameters', zodIssuesToDetails(parsed.error.issues));
         return;
      }

      const result = await getActionHistory(parsed.data);
      sendSuccess(res, result);
   } catch (error) {
      logger.error({ error }, 'Get multisig action history failed');
      next(error);
   }
};
