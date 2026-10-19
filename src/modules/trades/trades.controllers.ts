import { Request, Response, NextFunction } from 'express';
import {
   TradesWalletParamSchema,
   TradesQuerySchema,
   BundleTradesQuerySchema,
} from './trades.schemas';
import { fetchWalletBundleTrades, fetchWalletTrades } from './trades.service';
import {
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   buildOffsetPaginationMeta,
   buildPaginationMeta,
} from '../../utils/pagination.utils';

/**
 * GET /trades/:wallet/bundles
 *
 * Paginated bundle trade history for a given wallet address with full per-item breakdown.
 * Each bundle entry includes: timestamp, total_cost, item count, and per-item key/amount/price.
 */
export async function httpGetWalletBundleTrades(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const parsedParams = TradesWalletParamSchema.safeParse(req.params);
      if (!parsedParams.success) {
         sendValidationError(
            res,
            'Invalid wallet parameter',
            zodIssuesToDetails(parsedParams.error.issues)
         );
         return;
      }

      const parsedQuery = BundleTradesQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
         sendValidationError(
            res,
            'Invalid query parameters',
            zodIssuesToDetails(parsedQuery.error.issues)
         );
         return;
      }

      const wallet = parsedParams.data.wallet;
      const [items, total, nextCursor] = await fetchWalletBundleTrades(
         wallet,
         parsedQuery.data
      );

      const offsetMeta = buildOffsetPaginationMeta({
         limit: parsedQuery.data.limit,
         offset: parsedQuery.data.offset,
         total,
      });

      const pageMeta = buildPaginationMeta({
         page:
            parsedQuery.data.page ??
            Math.floor(parsedQuery.data.offset / parsedQuery.data.limit) + 1,
         pageSize: parsedQuery.data.limit,
         totalItems: total,
      });

      const meta = {
         ...offsetMeta,
         ...pageMeta,
         nextCursor,
      };

      sendSuccess(res, {
         items,
         meta,
         total,
         has_more: offsetMeta.hasMore,
         cursor: nextCursor,
      });
   } catch (error) {
      next(error);
   }
}

/**
 * GET /trades/:wallet
 *
 * Paginated trade history for a given wallet address.
 * Combines single trades (type: single) and bundle trades (type: bundle).
 */
export async function httpGetWalletTrades(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const parsedParams = TradesWalletParamSchema.safeParse(req.params);
      if (!parsedParams.success) {
         sendValidationError(
            res,
            'Invalid wallet parameter',
            zodIssuesToDetails(parsedParams.error.issues)
         );
         return;
      }

      const parsedQuery = TradesQuerySchema.safeParse(req.query);
      if (!parsedQuery.success) {
         sendValidationError(
            res,
            'Invalid query parameters',
            zodIssuesToDetails(parsedQuery.error.issues)
         );
         return;
      }

      const wallet = parsedParams.data.wallet;
      const [items, total, nextCursor] = await fetchWalletTrades(
         wallet,
         parsedQuery.data
      );

      const offsetMeta = buildOffsetPaginationMeta({
         limit: parsedQuery.data.limit,
         offset: parsedQuery.data.offset,
         total,
      });

      const pageMeta = buildPaginationMeta({
         page:
            parsedQuery.data.page ??
            Math.floor(parsedQuery.data.offset / parsedQuery.data.limit) + 1,
         pageSize: parsedQuery.data.limit,
         totalItems: total,
      });

      const meta = {
         ...offsetMeta,
         ...pageMeta,
         nextCursor,
      };

      sendSuccess(res, {
         items,
         meta,
         total,
         has_more: offsetMeta.hasMore,
         cursor: nextCursor,
      });
   } catch (error) {
      next(error);
   }
}
