import type { Response } from 'express';
import { z } from 'zod';
import type { StellarSignedRequest } from '../../middlewares/stellar-signature.middleware';
import { ErrorCode } from '../../constants/error.constants';
import {
   sendError,
   sendForbidden,
   sendNotFound,
   sendSuccess,
} from '../../utils/api-response.utils';
import { logger } from '../../utils/logger.utils';
import { transferKeys } from '../keys/key-transfer.service';
import { KeyNotFoundError } from '../keys/key-fees.service';
import { PositionFrozenError } from '../keys/key-freeze.service';
import { StellarAddressSchema } from '../wallet/wallet.schemas';

export const transferSchema = z.object({
   toAddress: StellarAddressSchema,
   quantity: z.number().int().positive(),
   fromAddress: z.string().optional(),
   /**
    * One-time trade nonce for replay protection (#1194).
    */
   nonce: z.union([z.string(), z.number()]).optional(),
});

export type TransferRequestBody = z.infer<typeof transferSchema>;

export async function httpTransferCreatorKey(
   req: StellarSignedRequest,
   res: Response
): Promise<void> {
   const body = req.body as TransferRequestBody;
   const fromAddress = req.walletAddress || body.fromAddress;
   const keyId = String(req.params.id || req.params.keyId);

   if (!fromAddress) {
      sendError(res, 400, ErrorCode.BAD_REQUEST, 'Sender wallet address is required');
      return;
   }

   try {
      const result = await transferKeys(
         keyId,
         fromAddress,
         body.toAddress,
         body.quantity
      );
      sendSuccess(res, result, 200, 'Keys transferred successfully');
   } catch (error) {
      if (error instanceof KeyNotFoundError) {
         sendNotFound(res, 'Key');
         return;
      }
      if (error instanceof PositionFrozenError) {
         sendForbidden(res, error.message);
         return;
      }
      if (error instanceof Error) {
         if (
            error.message.includes('Insufficient balance') ||
            error.message.includes('Quantity must be positive') ||
            error.message.includes('Cannot transfer to the same address')
         ) {
            sendError(res, 400, ErrorCode.BAD_REQUEST, error.message);
            return;
         }
      }
      logger.error(
         { error, keyId, from: fromAddress, to: body.toAddress },
         'Key transfer failed'
      );
      throw error;
   }
}
