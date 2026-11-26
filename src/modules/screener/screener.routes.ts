import { Router } from 'express';
import { z } from 'zod';
import {
   sendNotFound,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { CursorChecksumError } from '../../utils/cursor.utils';
import {
   AuthenticatedRequest,
   requireJwtAuth,
} from '../../middlewares/jwt-auth.middleware';
import {
   ContradictoryRulesError,
   createSavedScreenSchema,
   screenerRunSchema,
} from './screener.schemas';
import {
   SavedScreenLimitError,
   SavedScreenNotFoundError,
   ScreenerService,
} from './screener.service';

export const screenerRouter = Router();
export const screensRouter = Router();

const idParamSchema = z.object({ id: z.string().trim().min(1).max(128) });

/**
 * POST /v1/screener/run
 * Executes composable metric filter rules against the key_metrics view.
 */
screenerRouter.post('/run', async (req, res, next) => {
   const parsed = screenerRunSchema.safeParse(req.body);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid screener query',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const result = await ScreenerService.run(
         parsed.data.rules,
         parsed.data.sort,
         parsed.data.cursor,
         parsed.data.limit
      );
      sendSuccess(res, result, 200, 'Screener results retrieved');
   } catch (error) {
      if (error instanceof ContradictoryRulesError) {
         sendValidationError(res, error.message);
         return;
      }
      if (error instanceof CursorChecksumError) {
         sendValidationError(res, 'Invalid cursor');
         return;
      }
      next(error);
   }
});

/**
 * GET /v1/screens
 * Lists saved screens for the authenticated wallet.
 */
screensRouter.get('/', requireJwtAuth, async (req: AuthenticatedRequest, res, next) => {
   try {
      const screens = await ScreenerService.listScreens(req.user!.wallet);
      sendSuccess(res, { screens }, 200, 'Saved screens retrieved');
   } catch (error) {
      next(error);
   }
});

/**
 * POST /v1/screens
 * Saves a named screener configuration for the authenticated wallet (max 20).
 */
screensRouter.post('/', requireJwtAuth, async (req: AuthenticatedRequest, res, next) => {
   const parsed = createSavedScreenSchema.safeParse(req.body);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid saved screen payload',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const screen = await ScreenerService.createScreen(
         req.user!.wallet,
         parsed.data
      );
      sendSuccess(res, { screen }, 201, 'Saved screen created');
   } catch (error) {
      if (
         error instanceof ContradictoryRulesError ||
         error instanceof SavedScreenLimitError
      ) {
         sendValidationError(res, error.message);
         return;
      }
      next(error);
   }
});

/**
 * DELETE /v1/screens/:id
 * Deletes a saved screen owned by the authenticated wallet.
 */
screensRouter.delete('/:id', requireJwtAuth, async (req: AuthenticatedRequest, res, next) => {
   const params = idParamSchema.safeParse(req.params);
   if (!params.success) {
      sendValidationError(
         res,
         'Invalid screen identifier',
         zodIssuesToDetails(params.error.issues)
      );
      return;
   }

   try {
      await ScreenerService.deleteScreen(req.user!.wallet, params.data.id);
      sendSuccess(res, { deleted: true }, 200, 'Saved screen deleted');
   } catch (error) {
      if (error instanceof SavedScreenNotFoundError) {
         sendNotFound(res, 'Saved screen');
         return;
      }
      next(error);
   }
});
