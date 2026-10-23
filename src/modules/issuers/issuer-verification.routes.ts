// src/modules/issuers/issuer-verification.routes.ts
// Public verification badge reads for issuers (#1179). Mounted at /issuers
// alongside the existing reputation routes.

import { Router } from 'express';
import { StrKey } from '@stellar/stellar-base';
import { z } from 'zod';
import {
   ErrorCode,
   sendError,
   sendPaginatedSuccess,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   getIssuerVerificationStatus,
   listVerifiedIssuers,
} from './issuer-verification.service';

export const issuerVerificationRouter = Router();

const pageQuerySchema = z.object({
   page: z.coerce.number().int().min(1).max(100000).default(1),
   limit: z.coerce.number().int().min(1).max(100).default(20),
});

const walletSchema = z
   .string()
   .refine(StrKey.isValidEd25519PublicKey, 'Invalid Stellar wallet');

/** GET /issuers/verified — paginated list of currently verified issuers. */
issuerVerificationRouter.get('/verified', async (req, res, next) => {
   const query = pageQuerySchema.safeParse(req.query);
   if (!query.success) {
      sendValidationError(
         res,
         'Invalid query',
         zodIssuesToDetails(query.error.issues)
      );
      return;
   }
   try {
      const { data, meta } = await listVerifiedIssuers(query.data);
      sendPaginatedSuccess(res, data, meta);
   } catch (error) {
      next(error);
   }
});

/** GET /issuers/:wallet/verification — verification status for one issuer. */
issuerVerificationRouter.get(
   '/:wallet/verification',
   async (req, res, next) => {
      const wallet = walletSchema.safeParse(req.params.wallet);
      if (!wallet.success) {
         sendError(
            res,
            400,
            ErrorCode.VALIDATION_ERROR,
            'Invalid Stellar wallet'
         );
         return;
      }
      try {
         sendSuccess(res, await getIssuerVerificationStatus(wallet.data));
      } catch (error) {
         next(error);
      }
   }
);
