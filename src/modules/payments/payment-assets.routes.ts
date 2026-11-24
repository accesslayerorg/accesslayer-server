// src/modules/payments/payment-assets.routes.ts
// Multi-asset payment registry and buy quote routes (#1309).

import { Router } from 'express';
import { z } from 'zod';
import {
   ErrorCode,
   sendError,
   sendNotFound,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   InvalidQuoteInputError,
   KeyNotFoundForQuoteError,
   PaymentAssetNotFoundError,
   quoteService,
} from './quote.service';

export const paymentAssetsRouter = Router();
export const quotesRouter = Router();

const BuyQuoteQuerySchema = z.object({
   keyId: z.string().trim().min(1, 'keyId is required'),
   quantity: z.coerce
      .number()
      .int('quantity must be an integer')
      .positive('quantity must be positive'),
   asset: z.string().trim().min(1, 'asset is required'),
   slippageBps: z.coerce
      .number()
      .int()
      .min(0)
      .max(5000)
      .optional(),
});

/**
 * GET /v1/payment-assets
 * Returns enabled payment assets with decimals and current rates.
 */
paymentAssetsRouter.get('/', async (_req, res, next) => {
   try {
      const assets = await quoteService.listEnabledAssets();
      sendSuccess(
         res,
         assets.map(a => ({
            token: a.token,
            symbol: a.symbol,
            decimals: a.decimals,
            oracle: a.oracle,
            rate: a.rateFormatted,
            rate7: a.rate7.toString(),
            rateAgeSeconds: a.rateAgeSeconds,
            stale: a.stale,
            fallbackSource: a.fallbackSource,
            fetchedAt: a.fetchedAt,
         }))
      );
   } catch (error) {
      next(error);
   }
});

/**
 * GET /v1/quotes/buy?keyId=&quantity=&asset=
 * Returns converted buy quote with fees, rate, staleness, and recommended maxPay.
 */
quotesRouter.get('/buy', async (req, res, next) => {
   const parsed = BuyQuoteQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid quote parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const quote = await quoteService.getBuyQuote(parsed.data);
      sendSuccess(res, quote);
   } catch (error) {
      if (error instanceof KeyNotFoundForQuoteError) {
         sendNotFound(res, 'Key');
         return;
      }
      if (error instanceof PaymentAssetNotFoundError) {
         sendNotFound(res, 'Payment asset');
         return;
      }
      if (error instanceof InvalidQuoteInputError) {
         sendError(res, 400, ErrorCode.VALIDATION_ERROR, error.message);
         return;
      }
      next(error);
   }
});
