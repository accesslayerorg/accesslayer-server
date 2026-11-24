// src/modules/regions/regions.routes.ts
// GET /regions/me and admin CRUD for jurisdiction rules (#1354).

import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { adminGuard } from '../../middlewares/admin-guard.middleware';
import {
   ErrorCode,
   ErrorCodeType,
   sendError,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { logger } from '../../utils/logger.utils';
import {
   createRegionRule,
   deleteRegionRule,
   findRestrictions,
   getActiveRegionRules,
   listRegionRules,
   RegionServiceError,
   resolveRegionContext,
   updateRegionRule,
} from './regions.service';

const featureSchema = z
   .string()
   .trim()
   .regex(/^[a-z][a-z0-9_.-]{1,63}$/, 'feature must be a lower-case identifier');
const countryCodeSchema = z
   .string()
   .trim()
   .regex(/^[A-Za-z]{2}$/, 'countryCode must be an ISO 3166-1 alpha-2 code')
   .transform(code => code.toUpperCase());
const reasonSchema = z
   .string()
   .trim()
   .regex(/^[A-Z][A-Z0-9_]{2,63}$/, 'reason must be an upper-case reason code');

const createRuleSchema = z.object({
   feature: featureSchema,
   countryCode: countryCodeSchema,
   reason: reasonSchema,
});

const updateRuleSchema = createRuleSchema
   .partial()
   .refine(body => Object.keys(body).length > 0, 'Provide at least one field to update');

function handleRegionError(res: Response, error: unknown, context: string): void {
   if (error instanceof RegionServiceError) {
      sendError(res, error.statusCode, error.code as ErrorCodeType, error.message);
      return;
   }
   logger.error({ error }, context);
   sendError(res, 500, ErrorCode.INTERNAL_ERROR, context);
}

export const regionsRouter = Router();

regionsRouter.get('/me', async (req: Request, res: Response) => {
   try {
      const context = await resolveRegionContext(req);
      const rules = await getActiveRegionRules();
      res.setHeader('Cache-Control', 'private, no-store');
      sendSuccess(res, {
         detectedCountry: context.detectedCountry,
         declaredCountry: context.declaredCountry,
         restrictedFeatures: findRestrictions(rules, [
            context.detectedCountry,
            context.declaredCountry,
         ]),
      });
   } catch (error) {
      handleRegionError(res, error, 'Failed to resolve region restrictions');
   }
});

export const regionRulesAdminRouter = Router();

regionRulesAdminRouter.get('/', adminGuard, async (_req: Request, res: Response) => {
   try {
      sendSuccess(res, { rules: await listRegionRules() });
   } catch (error) {
      handleRegionError(res, error, 'Failed to list region rules');
   }
});

regionRulesAdminRouter.post('/', adminGuard, async (req: Request, res: Response) => {
   const parsed = createRuleSchema.safeParse(req.body);
   if (!parsed.success) {
      sendValidationError(res, 'Invalid region rule', zodIssuesToDetails(parsed.error.issues));
      return;
   }
   try {
      sendSuccess(res, { rule: await createRegionRule(parsed.data) }, 201);
   } catch (error) {
      handleRegionError(res, error, 'Failed to create region rule');
   }
});

regionRulesAdminRouter.patch('/:id', adminGuard, async (req: Request, res: Response) => {
   const parsed = updateRuleSchema.safeParse(req.body);
   if (!parsed.success) {
      sendValidationError(res, 'Invalid region rule update', zodIssuesToDetails(parsed.error.issues));
      return;
   }
   try {
      sendSuccess(res, { rule: await updateRegionRule(String(req.params.id), parsed.data) });
   } catch (error) {
      handleRegionError(res, error, 'Failed to update region rule');
   }
});

regionRulesAdminRouter.delete('/:id', adminGuard, async (req: Request, res: Response) => {
   try {
      await deleteRegionRule(String(req.params.id));
      res.status(204).end();
   } catch (error) {
      handleRegionError(res, error, 'Failed to delete region rule');
   }
});
