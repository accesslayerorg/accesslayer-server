// src/modules/portfolio/portfolio-health-score.routes.ts
// GET /investors/:wallet/health-score (#1178). Public read of public on-chain
// data; mounted at /investors.

import { Router } from 'express';
import { StrKey } from '@stellar/stellar-base';
import { z } from 'zod';
import {
   ErrorCode,
   sendError,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   getInvestorHealthScore,
   HealthScoreUnavailableError,
} from './portfolio-health-score.service';

export const investorHealthRouter = Router();

const paramsSchema = z.object({
   wallet: z
      .string()
      .refine(StrKey.isValidEd25519PublicKey, 'Invalid Stellar wallet'),
});

investorHealthRouter.get('/:wallet/health-score', async (req, res, next) => {
   const params = paramsSchema.safeParse(req.params);
   if (!params.success) {
      sendValidationError(
         res,
         'Invalid wallet',
         zodIssuesToDetails(params.error.issues)
      );
      return;
   }
   try {
      sendSuccess(res, await getInvestorHealthScore(params.data.wallet));
   } catch (error) {
      if (error instanceof HealthScoreUnavailableError) {
         sendError(
            res,
            503,
            ErrorCode.SERVICE_UNAVAILABLE,
            error.message
         );
         return;
      }
      next(error);
   }
});
