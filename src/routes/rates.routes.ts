// src/routes/rates.routes.ts
// XLM fiat rate proxy (#1219).
//
// GET /xlm?currencies=usd,eur,ngn
//
// Validates the requested ISO codes, asks FiatRateService for cached/live
// quotes and returns `{ base, rates, fetchedAt, stale }`. The route is
// rate-limited per IP to 60 requests per minute.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
   ErrorCode,
   sendError,
   sendValidationError,
   zodIssuesToDetails,
} from '../utils/api-response.utils';
import { sendRateLimitError } from '../utils/rate-limit-response.utils';
import { logger } from '../utils/logger.utils';
import {
   FiatRateUpstreamError,
   SUPPORTED_CURRENCIES,
   fiatRateService,
   isSupportedCurrency,
   type SupportedCurrency,
} from '../services/fiat-rate.service';

/** Window for the per-IP limit on this route. */
export const FIAT_RATES_RATE_LIMIT_WINDOW_MS = 60_000;

/** Maximum requests per IP within the window. */
export const FIAT_RATES_RATE_LIMIT_MAX = 60;

const DEFAULT_CURRENCIES_QUERY = SUPPORTED_CURRENCIES.join(',');

/**
 * Validates the `currencies` query parameter.
 *
 * Accepts `usd,eur,ngn` (case-insensitive) or repeated `currencies` params,
 * de-duplicates the list and rejects any code outside SUPPORTED_CURRENCIES
 * with a descriptive issue. Omitting the parameter returns every supported
 * currency.
 */
export const fiatRatesQuerySchema = z.object({
   currencies: z
      .preprocess(
         value => (Array.isArray(value) ? value.join(',') : value),
         z.string().optional().default(DEFAULT_CURRENCIES_QUERY)
      )
      .transform(raw =>
         Array.from(
            new Set(
               raw
                  .split(',')
                  .map(currency => currency.trim().toLowerCase())
                  .filter(currency => currency.length > 0)
            )
         )
      )
      .superRefine((currencies, ctx) => {
         if (currencies.length === 0) {
            ctx.addIssue({
               code: z.ZodIssueCode.custom,
               message: 'At least one currency code is required',
            });
            return;
         }

         for (const currency of currencies) {
            if (!isSupportedCurrency(currency)) {
               ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: `Unsupported currency "${currency}". Supported currencies are: ${SUPPORTED_CURRENCIES.join(
                     ', '
                  )}`,
               });
            }
         }
      })
      .transform(
         currencies =>
            currencies.filter(isSupportedCurrency) as SupportedCurrency[]
      ),
});

/**
 * Builds a fresh rate limiter instance. Exported so tests can exercise the
 * limiter in isolation without sharing its in-memory store.
 */
export function createXlmRatesRateLimit() {
   return rateLimit({
      windowMs: FIAT_RATES_RATE_LIMIT_WINDOW_MS,
      max: FIAT_RATES_RATE_LIMIT_MAX,
      standardHeaders: true,
      legacyHeaders: false,
      handler: (req, res) => {
         logger.warn(
            {
               requestId: req.requestId,
               method: req.method,
               path: req.path,
            },
            'Fiat rates rate limit exceeded'
         );
         sendRateLimitError(res, FIAT_RATES_RATE_LIMIT_WINDOW_MS / 1000);
      },
   });
}

/** Per-IP limiter protecting the upstream provider. */
export const xlmRatesRateLimit = createXlmRatesRateLimit();

const ratesRouter = Router();

/**
 * GET /xlm
 *
 * Returns XLM quotes in the requested fiat currencies. Unsupported codes are
 * rejected with 400; an upstream outage with no cached snapshot returns 503,
 * while a snapshot younger than 10 minutes is served with `stale: true`.
 */
ratesRouter.get('/xlm', xlmRatesRateLimit, async (req, res, next) => {
   const parsed = fiatRatesQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      const details = zodIssuesToDetails(parsed.error.issues);
      sendValidationError(
         res,
         details[0]?.message ?? 'Invalid currencies query parameter',
         details
      );
      return;
   }

   try {
      const rates = await fiatRateService.getRates(parsed.data.currencies);
      res.json(rates);
   } catch (error) {
      if (error instanceof FiatRateUpstreamError) {
         logger.error(
            { error: error.message },
            'XLM fiat rates are unavailable and no cached snapshot exists'
         );
         sendError(
            res,
            503,
            ErrorCode.SERVICE_UNAVAILABLE,
            'XLM fiat rates are temporarily unavailable. Please try again later.'
         );
         return;
      }
      next(error);
   }
});

export default ratesRouter;
