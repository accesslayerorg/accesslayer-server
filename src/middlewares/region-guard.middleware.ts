// src/middlewares/region-guard.middleware.ts
// Blocks a feature for callers in restricted jurisdictions (#1354).
//
//    router.post('/buy', regionGuard('key_trading'), handler);
//
// Restricted callers get HTTP 451 with error code REGION_RESTRICTED and the
// rule's neutral reason code in `error.details[0].message`. Every decision is
// logged with a hashed IP only. If the rules cannot be loaded the guard fails
// closed with 503, so an outage never silently lifts a restriction.

import type { NextFunction, Request, Response } from 'express';
import { ErrorCode, sendError } from '../utils/api-response.utils';
import { logger } from '../utils/logger.utils';
import {
   findRestrictions,
   getActiveRegionRules,
   RegionServiceError,
   resolveRegionContext,
} from '../modules/regions/regions.service';

export const REGION_RESTRICTED_MESSAGE = 'This feature is not available in your region.';

export function regionGuard(feature: string) {
   return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      let context;
      try {
         context = await resolveRegionContext(req);
      } catch (error) {
         if (error instanceof RegionServiceError) {
            sendError(res, error.statusCode, ErrorCode.VALIDATION_ERROR, error.message);
            return;
         }
         next(error);
         return;
      }

      let rules;
      try {
         rules = await getActiveRegionRules();
      } catch (error) {
         logger.error(
            { type: 'region_guard_rules_unavailable', feature, ipHash: context.ipHash, error },
            'Region rules unavailable; failing closed'
         );
         sendError(res, 503, ErrorCode.SERVICE_UNAVAILABLE, 'Service temporarily unavailable');
         return;
      }

      const [restriction] = findRestrictions(
         rules,
         [context.detectedCountry, context.declaredCountry],
         feature
      );

      logger.info(
         {
            type: 'region_guard_decision',
            feature,
            decision: restriction ? 'blocked' : 'allowed',
            reason: restriction?.reason,
            detectedCountry: context.detectedCountry,
            declaredCountry: context.declaredCountry,
            ipHash: context.ipHash,
         },
         'Region guard decision'
      );

      if (restriction) {
         sendError(res, 451, ErrorCode.REGION_RESTRICTED, REGION_RESTRICTED_MESSAGE, [
            { field: 'reason', message: restriction.reason },
         ]);
         return;
      }
      next();
   };
}
