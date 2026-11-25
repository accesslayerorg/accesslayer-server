// src/modules/dca/dca.routes.ts
// Recurring purchase (DCA) plan endpoints with wallet auth (#1322).

import { Router } from 'express';
import { z } from 'zod';
import {
   AuthenticatedRequest,
   requireJwtAuth,
} from '../../middlewares/jwt-auth.middleware';
import {
   sendForbidden,
   sendNotFound,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   DcaPlanForbiddenError,
   DcaPlanNotFoundError,
   dcaService,
} from './dca.service';

export const dcaRouter = Router();

dcaRouter.use(requireJwtAuth);

const CreateDcaPlanSchema = z.object({
   keyId: z.string().trim().min(1),
   amount: z.string().regex(/^\d+$/, 'amount must be a positive integer string'),
   frequency: z.enum(['hourly', 'daily', 'weekly', 'monthly']),
   budgetRemaining: z
      .string()
      .regex(/^\d+$/, 'budgetRemaining must be a non-negative integer string'),
   maxSlippageBps: z.coerce.number().int().min(0).max(5000).default(100),
   nextRunAt: z.string().datetime().optional(),
   spendingAuth: z.string().min(1).optional(),
});

const UpdateDcaPlanSchema = z.object({
   amount: z
      .string()
      .regex(/^\d+$/, 'amount must be a positive integer string')
      .optional(),
   frequency: z.enum(['hourly', 'daily', 'weekly', 'monthly']).optional(),
   budgetRemaining: z
      .string()
      .regex(/^\d+$/, 'budgetRemaining must be a non-negative integer string')
      .optional(),
   maxSlippageBps: z.coerce.number().int().min(0).max(5000).optional(),
   status: z.enum(['active', 'paused']).optional(),
   spendingAuth: z.string().min(1).optional(),
});

dcaRouter.post('/plans', async (req: AuthenticatedRequest, res, next) => {
   const parsed = CreateDcaPlanSchema.safeParse(req.body);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid DCA plan payload',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const plan = await dcaService.createPlan(req.user!.wallet, {
         keyId: parsed.data.keyId,
         amount: BigInt(parsed.data.amount),
         frequency: parsed.data.frequency,
         budgetRemaining: BigInt(parsed.data.budgetRemaining),
         maxSlippageBps: parsed.data.maxSlippageBps,
         nextRunAt: parsed.data.nextRunAt
            ? new Date(parsed.data.nextRunAt)
            : undefined,
         spendingAuth: parsed.data.spendingAuth,
      });
      sendSuccess(res, plan, 201);
   } catch (error) {
      next(error);
   }
});

dcaRouter.patch('/plans/:id', async (req: AuthenticatedRequest, res, next) => {
   const parsed = UpdateDcaPlanSchema.safeParse(req.body);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid DCA plan update payload',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const plan = await dcaService.updatePlan(
         req.user!.wallet,
         String(req.params.id),
         {
            amount:
               parsed.data.amount !== undefined
                  ? BigInt(parsed.data.amount)
                  : undefined,
            frequency: parsed.data.frequency,
            budgetRemaining:
               parsed.data.budgetRemaining !== undefined
                  ? BigInt(parsed.data.budgetRemaining)
                  : undefined,
            maxSlippageBps: parsed.data.maxSlippageBps,
            status: parsed.data.status,
            spendingAuth: parsed.data.spendingAuth,
         }
      );
      sendSuccess(res, plan);
   } catch (error) {
      if (error instanceof DcaPlanNotFoundError) {
         sendNotFound(res, 'DCA plan');
         return;
      }
      if (error instanceof DcaPlanForbiddenError) {
         sendForbidden(res, error.message);
         return;
      }
      next(error);
   }
});

dcaRouter.delete('/plans/:id', async (req: AuthenticatedRequest, res, next) => {
   try {
      await dcaService.deletePlan(req.user!.wallet, String(req.params.id));
      sendSuccess(res, { deleted: true });
   } catch (error) {
      if (error instanceof DcaPlanNotFoundError) {
         sendNotFound(res, 'DCA plan');
         return;
      }
      if (error instanceof DcaPlanForbiddenError) {
         sendForbidden(res, error.message);
         return;
      }
      next(error);
   }
});

dcaRouter.get('/plans/:id/runs', async (req: AuthenticatedRequest, res, next) => {
   try {
      const limit =
         typeof req.query.limit === 'string' ? Number(req.query.limit) : 50;
      const runs = await dcaService.listPlanRuns(
         req.user!.wallet,
         String(req.params.id),
         Number.isFinite(limit) ? limit : 50
      );
      sendSuccess(res, runs);
   } catch (error) {
      if (error instanceof DcaPlanNotFoundError) {
         sendNotFound(res, 'DCA plan');
         return;
      }
      if (error instanceof DcaPlanForbiddenError) {
         sendForbidden(res, error.message);
         return;
      }
      next(error);
   }
});
