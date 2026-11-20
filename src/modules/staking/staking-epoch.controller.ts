// src/modules/staking/staking-epoch.controller.ts
// HTTP handlers for the staking epoch REST endpoints (#1086).
//
//   GET /staking/:wallet/positions
//   GET /staking/:wallet/positions/:stakeId
//   GET /keys/:keyId/epochs

import { Response } from 'express';
import { AuthenticatedRequest } from '../../middlewares/jwt-auth.middleware';
import {
   ErrorCode,
   sendError,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { logger } from '../../utils/logger.utils';
import {
   getActivePositions,
   getPosition,
   getKeyEpochs,
   StakeNotFoundError,
} from './staking-epoch.service';
import {
   PositionsQuerySchema,
   PositionDetailQuerySchema,
   KeyEpochsQuerySchema,
} from './staking-epoch.schemas';

// ── GET /staking/:wallet/positions ────────────────────────────

/**
 * Returns all active staking positions for the authenticated wallet, each
 * hydrated with live accrued rewards from the contract.
 *
 * `currentEpoch` query param (optional, default 0) is used to compute
 * `epochsRemaining` for locked positions.
 */
export async function httpGetStakingPositions(
   req: AuthenticatedRequest,
   res: Response
): Promise<void> {
   const wallet = String(req.params.wallet ?? '').trim();

   const parsed = PositionsQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid query parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const positions = await getActivePositions(
         wallet,
         parsed.data.currentEpoch
      );
      sendSuccess(res, positions);
   } catch (error) {
      logger.error(
         {
            type: 'staking_epoch_handler_error',
            handler: 'httpGetStakingPositions',
            wallet,
            ...(req.requestId ? { requestId: req.requestId } : {}),
            error,
         },
         'Failed to retrieve staking positions'
      );
      sendError(
         res,
         500,
         ErrorCode.INTERNAL_ERROR,
         'Failed to retrieve staking positions'
      );
   }
}

// ── GET /staking/:wallet/positions/:stakeId ───────────────────

/**
 * Returns a single active staking position with live accrued rewards and the
 * full epoch reward history for its key.
 *
 * Returns 404 when the stake does not exist or belongs to a different wallet.
 */
export async function httpGetStakingPosition(
   req: AuthenticatedRequest,
   res: Response
): Promise<void> {
   const wallet = String(req.params.wallet ?? '').trim();
   const stakeId = String(req.params.stakeId ?? '').trim();

   const parsed = PositionDetailQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid query parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   try {
      const detail = await getPosition(
         stakeId,
         wallet,
         parsed.data.currentEpoch
      );
      sendSuccess(res, detail);
   } catch (error) {
      if (error instanceof StakeNotFoundError) {
         sendError(res, 404, ErrorCode.NOT_FOUND, 'Stake not found');
         return;
      }
      logger.error(
         {
            type: 'staking_epoch_handler_error',
            handler: 'httpGetStakingPosition',
            wallet,
            stakeId,
            ...(req.requestId ? { requestId: req.requestId } : {}),
            error,
         },
         'Failed to retrieve staking position'
      );
      sendError(
         res,
         500,
         ErrorCode.INTERNAL_ERROR,
         'Failed to retrieve staking position'
      );
   }
}

// ── GET /keys/:keyId/epochs ───────────────────────────────────

/**
 * Returns the epoch reward history for a creator key, ordered oldest-first.
 * Offset-paginated via `limit` and `offset` query params.
 */
export async function httpGetKeyEpochs(
   req: AuthenticatedRequest,
   res: Response
): Promise<void> {
   const keyId = String(req.params.keyId ?? '').trim();

   const parsed = KeyEpochsQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid query parameters',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }

   const { limit, offset } = parsed.data;

   try {
      const { items, total } = await getKeyEpochs(keyId, limit, offset);
      sendSuccess(res, {
         items,
         meta: {
            total,
            limit,
            offset,
            hasMore: offset + items.length < total,
         },
      });
   } catch (error) {
      logger.error(
         {
            type: 'staking_epoch_handler_error',
            handler: 'httpGetKeyEpochs',
            keyId,
            ...(req.requestId ? { requestId: req.requestId } : {}),
            error,
         },
         'Failed to retrieve key epoch history'
      );
      sendError(
         res,
         500,
         ErrorCode.INTERNAL_ERROR,
         'Failed to retrieve key epoch history'
      );
   }
}
