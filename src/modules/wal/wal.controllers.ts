import { RequestHandler } from 'express';
import { prisma } from '../../utils/prisma.utils';
import {
   sendSuccess,
   sendError,
   sendValidationError,
   ErrorCode,
} from '../../utils/api-response.utils';
import {
   SubmitTradeSchema,
   GetWALEntryParamSchema,
   TriggerRecoverySchema,
} from './wal.schemas';
import { sorobanWALService } from './wal.service';
import { defaultWALRecoveryWorker } from './wal-recovery.worker';

/**
 * POST /api/v1/wal/submit
 * Submits a buy or sell trade via the write-ahead log flow.
 */
export const submitTrade: RequestHandler = async (req, res) => {
   try {
      const parseResult = SubmitTradeSchema.safeParse(req.body);
      if (!parseResult.success) {
         return sendValidationError(
            res,
            'Validation error',
            parseResult.error.errors
         );
      }

      const result = await sorobanWALService.executeBuySellFlow(
         parseResult.data
      );

      return sendSuccess(
         res,
         result,
         result.confirmed ? 200 : 202,
         'Trade processed'
      );
   } catch (error: any) {
      return sendError(
         res,
         400,
         ErrorCode.BAD_REQUEST,
         error.message || 'Failed to submit trade via WAL'
      );
   }
};

/**
 * GET /api/v1/wal/entry/:idOrTxHash
 * Retrieves a WAL entry by its internal ID or on-chain transaction hash.
 */
export const getWALEntry: RequestHandler = async (req, res) => {
   try {
      const parseResult = GetWALEntryParamSchema.safeParse(req.params);
      if (!parseResult.success) {
         return sendValidationError(
            res,
            'Validation error',
            parseResult.error.errors
         );
      }

      const { idOrTxHash } = parseResult.data;

      const entry = await prisma.sorobanWALEntry.findFirst({
         where: {
            OR: [{ id: idOrTxHash }, { txHash: idOrTxHash }],
         },
      });

      if (!entry) {
         return sendError(res, 404, ErrorCode.NOT_FOUND, 'WAL entry not found');
      }

      return sendSuccess(res, entry, 200, 'WAL entry retrieved');
   } catch (error: any) {
      return sendError(res, 500, ErrorCode.INTERNAL_ERROR, error.message);
   }
};

/**
 * POST /api/v1/wal/recovery/trigger
 * Triggers an immediate WAL crash recovery cycle.
 */
export const triggerRecovery: RequestHandler = async (req, res) => {
   try {
      const parseResult = TriggerRecoverySchema.safeParse(req.body);
      const options = parseResult.success ? parseResult.data : {};

      const summary = await defaultWALRecoveryWorker.runRecovery(options);
      return sendSuccess(res, summary, 200, 'Recovery cycle completed');
   } catch (error: any) {
      return sendError(res, 500, ErrorCode.INTERNAL_ERROR, error.message);
   }
};
