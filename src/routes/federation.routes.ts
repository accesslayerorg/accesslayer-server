// src/routes/federation.routes.ts
// Stellar federation resolution proxy (#1222).
//
// GET /v1/federation/resolve?address=name*domain
//
// Federation servers usually lack CORS headers, so browsers cannot query them
// directly. This endpoint resolves the address server-side, with SSRF
// protection and short-lived Redis caching, and returns
// `{ accountId, memo?, memoType? }`.

import { Router } from 'express';
import { z } from 'zod';
import {
   ErrorCode,
   sendError,
   sendNotFound,
   sendValidationError,
   zodIssuesToDetails,
} from '../utils/api-response.utils';
import { logger } from '../utils/logger.utils';
import {
   FederationAddressError,
   FederationBlockedAddressError,
   FederationNotFoundError,
   FederationTimeoutError,
   FederationUpstreamError,
   federationService,
   parseFederationAddress,
} from '../services/federation.service';

/** Validates and normalizes the `address` query parameter. */
export const federationResolveQuerySchema = z.object({
   address: z
      .string({
         required_error: 'address query parameter is required',
      })
      .trim()
      .min(1, 'address query parameter is required')
      .superRefine((value, ctx) => {
         if (!parseFederationAddress(value)) {
            ctx.addIssue({
               code: z.ZodIssueCode.custom,
               message:
                  'Invalid federation address. Expected name*domain with a valid domain, for example alice*example.com',
            });
         }
      })
      .transform(value => parseFederationAddress(value)!),
});

const federationRouter = Router();

/**
 * GET /resolve
 *
 * Resolves a Stellar federation address. Malformed addresses and domains
 * pointing at private address space return 400, unknown addresses return 404,
 * timeouts return 504 and federation server failures return 502.
 */
federationRouter.get('/resolve', async (req, res, next) => {
   const parsed = federationResolveQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      const details = zodIssuesToDetails(parsed.error.issues);
      sendValidationError(
         res,
         details[0]?.message ?? 'Invalid federation address',
         details
      );
      return;
   }

   try {
      const resolution = await federationService.resolve(
         parsed.data.address.address
      );
      res.json(resolution);
   } catch (error) {
      if (error instanceof FederationAddressError) {
         sendValidationError(res, error.message, [
            { field: 'address', message: error.message },
         ]);
         return;
      }

      if (error instanceof FederationBlockedAddressError) {
         logger.warn(
            {
               type: 'federation_blocked_address',
               address: parsed.data.address.address,
               error: error.message,
            },
            'Blocked federation lookup to non-public address space'
         );
         sendError(
            res,
            400,
            ErrorCode.BAD_REQUEST,
            'Federation domain resolves to a non-public address and cannot be queried'
         );
         return;
      }

      if (error instanceof FederationNotFoundError) {
         sendNotFound(res, 'Federation address');
         return;
      }

      if (error instanceof FederationTimeoutError) {
         sendError(
            res,
            504,
            ErrorCode.GATEWAY_TIMEOUT,
            'Federation lookup timed out. Please try again.'
         );
         return;
      }

      if (error instanceof FederationUpstreamError) {
         logger.error(
            {
               type: 'federation_upstream_failure',
               address: parsed.data.address.address,
               error: error.message,
            },
            'Federation upstream lookup failed'
         );
         sendError(
            res,
            502,
            ErrorCode.BAD_GATEWAY,
            'Federation server is currently unavailable. Please try again later.'
         );
         return;
      }

      next(error);
   }
});

export default federationRouter;
