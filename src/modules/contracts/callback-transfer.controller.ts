// src/modules/contracts/callback-transfer.controller.ts
// GET /api/v1/contracts/:address/received (#1274)
import { z } from 'zod';
import type { AsyncController } from '../../types/auth.types';
import { sendError, sendSuccess } from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import { attachTimestampHeader } from '../../utils/timestamp-headers.utils';
import { listReceivedTransfers } from './callback-transfer.service';

const contractReceivedQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    cursor: z.string().min(1).optional(),
  })
  .strict();

/**
 * GET /api/v1/contracts/:address/received
 *
 * Transfers received by a contract (callback transfers), reverse
 * chronological, cursor-paginated.
 */
export const httpGetContractReceived: AsyncController = async (
  req,
  res,
  next
) => {
  try {
    const parsed = contractReceivedQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, 400, ErrorCode.BAD_REQUEST, 'Invalid query parameters');
      return;
    }
    const address = String(req.params.address || '').trim();
    if (!address) {
      sendError(res, 400, ErrorCode.BAD_REQUEST, 'Invalid contract address');
      return;
    }
    const { items, nextCursor } = await listReceivedTransfers(
      address,
      parsed.data.limit ?? 100,
      parsed.data.cursor
    );
    attachTimestampHeader(res);
    sendSuccess(res, { address, items, nextCursor });
  } catch (error) {
    next(error);
  }
};
