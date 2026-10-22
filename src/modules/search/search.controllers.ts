// src/modules/search/search.controllers.ts
import { AsyncController } from '../../types/auth.types';
import {
   sendError,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import {
   groupedSearchQuerySchema,
   searchPaginationQuerySchema,
} from './search.schemas';
import {
   getGroupedSearch,
   InvalidSearchCursorError,
   searchCreators,
   searchKeys,
   SearchQueryTooShortError,
} from './search.service';

/**
 * GET /api/v1/search?q=
 *
 * Grouped results for the client search overlay: top 3 keys, top 3 creators
 * and the top exact tx-hash match.
 */
export const httpSearch: AsyncController = async (req, res, next) => {
   const parsed = groupedSearchQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid search query',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      sendSuccess(res, await getGroupedSearch(parsed.data.q));
   } catch (error) {
      if (error instanceof SearchQueryTooShortError) {
         sendError(res, 400, ErrorCode.VALIDATION_ERROR, error.message);
         return;
      }
      next(error);
   }
};

/**
 * GET /api/v1/search/keys?q=&limit=&cursor=
 *
 * Cursor-paginated full key results, ranked by relevance.
 */
export const httpSearchKeys: AsyncController = async (req, res, next) => {
   const parsed = searchPaginationQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid search query',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const page = await searchKeys(parsed.data.q, {
         limit: parsed.data.limit,
         cursor: parsed.data.cursor,
      });
      sendSuccess(res, page);
   } catch (error) {
      if (
         error instanceof SearchQueryTooShortError ||
         error instanceof InvalidSearchCursorError
      ) {
         sendError(res, 400, ErrorCode.VALIDATION_ERROR, error.message);
         return;
      }
      next(error);
   }
};

/**
 * GET /api/v1/search/creators?q=&limit=&cursor=
 *
 * Cursor-paginated full creator results, ranked by relevance.
 */
export const httpSearchCreators: AsyncController = async (req, res, next) => {
   const parsed = searchPaginationQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid search query',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const page = await searchCreators(parsed.data.q, {
         limit: parsed.data.limit,
         cursor: parsed.data.cursor,
      });
      sendSuccess(res, page);
   } catch (error) {
      if (
         error instanceof SearchQueryTooShortError ||
         error instanceof InvalidSearchCursorError
      ) {
         sendError(res, 400, ErrorCode.VALIDATION_ERROR, error.message);
         return;
      }
      next(error);
   }
};
