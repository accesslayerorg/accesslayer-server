import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit';
import { envConfig } from '../config';
import { Request, Response } from 'express';
import { sendRateLimitError } from '../utils/rate-limit-response.utils';
import { logger } from '../utils/logger.utils';

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

export const appRateLimit: RateLimitRequestHandler = rateLimit({
   windowMs: RATE_LIMIT_WINDOW_MS,
   max: envConfig.MODE === 'production' ? 1000 : 10000,
   standardHeaders: true,
   legacyHeaders: false,
   handler: (req: Request, res: Response) => {
      logger.warn(
         { requestId: req.requestId, method: req.method, path: req.path },
         'Rate limit exceeded'
      );
      sendRateLimitError(res, RATE_LIMIT_WINDOW_MS / 1000);
   },
});
