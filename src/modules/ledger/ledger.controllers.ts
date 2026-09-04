import { Request, Response } from 'express';
import { prisma } from '../../utils/prisma.utils';
import {
   sendSuccess,
   sendError,
   ErrorCode,
} from '../../utils/api-response.utils';
import { attachTimestampHeader } from '../../utils/timestamp-headers.utils';
import { logger } from '../../utils/logger.utils';

/**
 * Controller for GET /api/v1/ledger/status
 *
 * Returns the latest indexed ledger, cursor, and sync timestamp.
 * Used by clients to verify sync state and by ops for monitoring.
 */
export const httpGetLedgerStatus = async (
   _req: Request,
   res: Response
): Promise<void> => {
   try {
      const status = await prisma.indexedLedger.findFirst({
         orderBy: { updatedAt: 'desc' },
      });

      if (!status) {
         res.status(200).json({
            success: true,
            data: {
               ledger: 0,
               cursor: '0',
               updatedAt: null,
               message: 'No ledgers indexed yet',
            },
         });
         return;
      }

      attachTimestampHeader(res);
      sendSuccess(res, {
         ledger: status.ledger,
         cursor: status.cursor,
         updatedAt: status.updatedAt.toISOString(),
      });
   } catch (error) {
      logger.error({ error }, 'Failed to fetch ledger status');
      sendError(
         res,
         500,
         ErrorCode.INTERNAL_ERROR,
         'Failed to fetch ledger status'
      );
   }
};
