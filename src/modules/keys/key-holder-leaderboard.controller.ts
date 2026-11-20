// src/modules/keys/key-holder-leaderboard.controller.ts
import { z } from 'zod';
import { AsyncController } from '../../types/auth.types';
import {
   sendError,
   sendNotFound,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import { attachTimestampHeader } from '../../utils/timestamp-headers.utils';
import { safeIntParam } from '../../utils/query.utils';
import { MAX_PAGE_SIZE } from '../../constants/pagination.constants';
import { isValidStellarAddress } from '../wallet/wallet.utils';
import {
   getHolderLeaderboard,
   getHolderRank,
   HolderLeaderboardKeyNotFoundError,
   HolderNotFoundError,
   HOLDER_LEADERBOARD_TOP_N,
   InvalidHolderCursorError,
} from './key-holder-leaderboard.service';

const holderLeaderboardQuerySchema = z
   .object({
      limit: safeIntParam({
         defaultValue: HOLDER_LEADERBOARD_TOP_N,
         min: 1,
         max: MAX_PAGE_SIZE,
         label: 'Limit',
      }),
      /** Opaque cursor from a previous page's `nextCursor`. */
      cursor: z.string().min(1).optional(),
   })
   .strict();

/**
 * GET /api/v1/keys/:keyId/holders/leaderboard
 *
 * Top holders ranked by balance (default 100) with supply percentage and
 * first-purchase date. Use `nextCursor` to page beyond the top 100.
 */
export const httpGetHolderLeaderboard: AsyncController = async (
   req,
   res,
   next
) => {
   try {
      const parsed = holderLeaderboardQuerySchema.safeParse(req.query);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid query parameters',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      const page = await getHolderLeaderboard(String(req.params.keyId), {
         limit: parsed.data.limit,
         cursor: parsed.data.cursor,
      });

      attachTimestampHeader(res);
      sendSuccess(res, page);
   } catch (error) {
      if (error instanceof HolderLeaderboardKeyNotFoundError) {
         sendNotFound(res, 'Key');
         return;
      }
      if (error instanceof InvalidHolderCursorError) {
         sendError(res, 400, ErrorCode.BAD_REQUEST, error.message);
         return;
      }
      next(error);
   }
};

/**
 * GET /api/v1/keys/:keyId/holders/:wallet/rank
 *
 * Rank, balance and supply share for a connected wallet. 404 when the
 * wallet holds no keys.
 */
export const httpGetHolderRank: AsyncController = async (req, res, next) => {
   try {
      const wallet = String(req.params.wallet);
      if (!isValidStellarAddress(wallet)) {
         sendValidationError(res, 'Invalid Stellar wallet address', [
            { field: 'wallet', message: 'Invalid Stellar wallet address' },
         ]);
         return;
      }

      const rank = await getHolderRank(String(req.params.keyId), wallet);

      attachTimestampHeader(res);
      sendSuccess(res, rank);
   } catch (error) {
      if (error instanceof HolderLeaderboardKeyNotFoundError) {
         sendNotFound(res, 'Key');
         return;
      }
      if (error instanceof HolderNotFoundError) {
         sendNotFound(res, 'Holder');
         return;
      }
      next(error);
   }
};
