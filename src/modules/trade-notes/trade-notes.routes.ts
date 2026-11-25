import { Router, Response, NextFunction } from 'express';
import {
   AuthenticatedRequest,
   requireJwtAuth,
} from '../../middlewares/jwt-auth.middleware';
import {
   sendForbidden,
   sendNotFound,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { CursorChecksumError } from '../../utils/cursor.utils';
import {
   listTradeNotesQuerySchema,
   txHashParamSchema,
   upsertTradeNoteSchema,
} from './trade-notes.schemas';
import {
   listTradeNotes,
   TradeNotFoundError,
   TradeOwnershipError,
   upsertTradeNote,
} from './trade-notes.service';

export const tradeNotesRouter = Router();

/**
 * PUT /v1/me/trade-notes/:txHash
 * Upsert a private note and tags on a trade owned by the authenticated wallet.
 */
tradeNotesRouter.put(
   '/trade-notes/:txHash',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      const txHashResult = txHashParamSchema.safeParse(req.params.txHash);
      if (!txHashResult.success) {
         sendValidationError(
            res,
            'Invalid txHash parameter',
            zodIssuesToDetails(txHashResult.error.issues)
         );
         return;
      }

      const bodyResult = upsertTradeNoteSchema.safeParse(req.body);
      if (!bodyResult.success) {
         sendValidationError(
            res,
            'Invalid trade note payload',
            zodIssuesToDetails(bodyResult.error.issues)
         );
         return;
      }

      const wallet = req.user!.wallet;

      try {
         const note = await upsertTradeNote(
            wallet,
            txHashResult.data,
            bodyResult.data
         );
         sendSuccess(res, note, 200);
      } catch (error) {
         if (error instanceof TradeOwnershipError) {
            sendForbidden(res, error.message);
            return;
         }
         if (error instanceof TradeNotFoundError) {
            sendNotFound(res, 'Trade');
            return;
         }
         next(error);
      }
   }
);

/**
 * GET /v1/me/trade-notes?tag=&keyId=&cursor=
 * List authenticated wallet's trade notes with cursor pagination and filters.
 */
tradeNotesRouter.get(
   '/trade-notes',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      const queryResult = listTradeNotesQuerySchema.safeParse(req.query);
      if (!queryResult.success) {
         sendValidationError(
            res,
            'Invalid query parameters',
            zodIssuesToDetails(queryResult.error.issues)
         );
         return;
      }

      const wallet = req.user!.wallet;

      try {
         const result = await listTradeNotes(wallet, queryResult.data);
         sendSuccess(res, result, 200);
      } catch (error) {
         if (error instanceof CursorChecksumError) {
            sendValidationError(res, error.message);
            return;
         }
         next(error);
      }
   }
);

export default tradeNotesRouter;
