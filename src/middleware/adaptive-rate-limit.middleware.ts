import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { logger } from '../utils/logger.utils';
import { sendRateLimitError } from '../utils/rate-limit-response.utils';
import { score as reputationScore, getBudgetForTier } from './reputation/reputation.service';

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute

export interface AdaptiveRateLimitOptions {
   /** Header name containing the wallet address (default: 'x-wallet-address') */
   walletAddressHeader?: string;
}

/**
 * Adaptive rate limit middleware that maps wallet reputation scores to
 * per-minute request budgets. Wallets with higher reputation scores receive
 * higher request limits.
 *
 * The middleware:
 * 1. Reads the wallet address from the request
 * 2. Fetches/reputationscore (cached for 5 minutes)
 * 3. Maps the score to a tier and budget
 * 4. Applies express-rate-limit with the tier's budget
 * 5. Returns 429 with Retry-After and tier info on exceedance
 */
export function adaptiveRateLimit(options: AdaptiveRateLimitOptions = {}): (
   req: Request,
   res: Response,
   next: NextFunction
) => Promise<void> {
   const { walletAddressHeader = 'x-wallet-address' } = options;

   return async (
      req: Request,
      res: Response,
      next: NextFunction
   ): Promise<void> => {
      const walletAddress = req.headers[walletAddressHeader] as string;

      if (!walletAddress) {
         next();
         return;
      }

      try {
         const { tier } = await reputationScore(walletAddress);
         const budgetPerMinute = getBudgetForTier(tier.name);

const adaptiveRateLimiter = rateLimit({
   windowMs: RATE_LIMIT_WINDOW_MS,
   max: budgetPerMinute,
   handler: (req: Request, res: Response) => {
      logger.warn(
         { requestId: req.headers['x-request-id'] || 'unknown',
            wallet: walletAddress,
            tier: tier.name,
            budget: budgetPerMinute },
         'Adaptive rate limit exceeded'
      );
      sendRateLimitError(res, RATE_LIMIT_WINDOW_MS / 1000);
   },
});

adaptiveRateLimiter(req, res, next);
      } catch (error) {
         // Fail open on errors - allow the request through
         logger.error(
            { error, wallet: walletAddress },
            'Reputation service error; allowing request through'
         );
         next();
      }
   };
}