// src/modules/portfolio/portfolio-history.schemas.ts
// Query validation for GET /portfolio/history (#1008).

import { z } from 'zod';
import { StellarAddressSchema } from '../wallet/wallet.schemas';
import { PORTFOLIO_HISTORY_RANGES } from './portfolio-history.service';

export const PortfolioHistoryQuerySchema = z
   .object({
      /** Stellar wallet whose holdings are charted. */
      wallet: StellarAddressSchema,
      /** Lookback range; defaults to the shortest one. */
      range: z.enum(PORTFOLIO_HISTORY_RANGES).default('7d'),
   })
   .strict();

export type PortfolioHistoryQueryType = z.infer<
   typeof PortfolioHistoryQuerySchema
>;
