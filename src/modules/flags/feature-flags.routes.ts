import { Router, Request } from 'express';
import { z } from 'zod';
import { adminGuard, AdminRequest } from '../../middlewares/admin-guard.middleware';
import { extractBearerToken, verifyWalletAccessToken } from '../../utils/jwt.utils';
import { sendSuccess, sendValidationError, zodIssuesToDetails } from '../../utils/api-response.utils';
import { createAuditEntry } from '../admin/audit-log.service';
import { FEATURE_FLAG_NAME_PATTERN, flagService } from './feature-flags.service';

export const flagRouter = Router();
export const adminFlagRouter = Router();

const nameSchema = z.string().regex(FEATURE_FLAG_NAME_PATTERN, 'Invalid feature flag name');

function requestingWallet(req: Request): string | undefined {
   const token = extractBearerToken(req.headers.authorization);
   if (token) {
      try {
         return verifyWalletAccessToken(token).wallet;
      } catch {
         // Public flag evaluation remains available for anonymous/invalid sessions.
      }
   }
   const headerWallet = req.header('x-wallet-address');
   if (headerWallet?.trim()) return headerWallet.trim();
   const queryWallet = typeof req.query.wallet === 'string' ? req.query.wallet.trim() : '';
   return queryWallet || undefined;
}

flagRouter.get('/', async (req, res, next) => {
   try {
      const context = {
         wallet: requestingWallet(req),
         environment: typeof req.query.environment === 'string'
            ? req.query.environment
            : undefined,
      };
      const definitions = await flagService.listDefinitions();
      sendSuccess(res, definitions.map(flag => ({
         name: flag.name,
         enabled: flagService.evaluateDefinition(flag, context),
         evaluated: flagService.evaluateDefinition(flag, context),
         rules: flag.rules,
      })));
   } catch (error) {
      next(error);
   }
});

adminFlagRouter.get('/flags', adminGuard, async (_req: AdminRequest, res, next) => {
   try {
      sendSuccess(res, await flagService.listDefinitions());
   } catch (error) {
      next(error);
   }
});

adminFlagRouter.put('/flags/:name', adminGuard, async (req: AdminRequest, res, next) => {
   const nameResult = nameSchema.safeParse(req.params.name);
   if (!nameResult.success) {
      sendValidationError(
         res,
         'Invalid feature flag name',
         zodIssuesToDetails(nameResult.error.issues)
      );
      return;
   }

   const bodyResult = z.object({
      enabled: z.boolean(),
      rules: z.unknown().optional().default({}),
   }).safeParse(req.body);
   if (!bodyResult.success) {
      sendValidationError(
         res,
         'Invalid feature flag update',
         zodIssuesToDetails(bodyResult.error.issues)
      );
      return;
   }

   try {
      const record = await flagService.update(
         nameResult.data,
         bodyResult.data.enabled,
         bodyResult.data.rules,
         req.adminId || 'unknown'
      );
      await createAuditEntry({
         actorWallet: req.adminId || 'unknown',
         actionType: 'FEATURE_FLAG_UPDATED',
         targetId: nameResult.data,
         payload: { name: nameResult.data, enabled: bodyResult.data.enabled, rules: bodyResult.data.rules },
      });
      sendSuccess(res, record);
   } catch (error) {
      next(error);
   }
});
