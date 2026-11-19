// src/modules/creator/transfer.controller.ts
// Transfer trade execution with Stellar signature verification and nonce replay protection (#1194).

import type { Response } from 'express';
import { z } from 'zod';
import type { StellarSignedRequest } from '../../middlewares/stellar-signature.middleware';
import { ErrorCode } from '../../constants/error.constants';
import {
   sendError,
   sendForbidden,
   sendNotFound,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { prisma } from '../../utils/prisma.utils';
import { assertTradingActive, TradingPausedError } from '../keys/key-trading.service';
import {
   assertPositionNotFrozen,
   PositionFrozenError,
} from '../keys/key-freeze.service';
import {
   assertWalletNotSuspended,
   WalletSuspendedError,
} from '../indexer/flash-loan-guard-indexer.service';
import { KeyNotFoundError } from '../keys/key-fees.service';
import { transferKeys } from '../keys/key-transfer.service';
import { StellarAddressSchema } from '../wallet/wallet.schemas';
import { logger } from '../../utils/logger.utils';

export const transferSchema = z.preprocess(
   (val: any) => {
      if (val && typeof val === 'object') {
         return {
            ...val,
            toAddress: val.toAddress ?? val.to_address,
            fromAddress: val.fromAddress ?? val.from_address,
         };
      }
      return val;
   },
   z.object({
      toAddress: z.string().min(1, 'toAddress is required'),
      quantity: z.number().int().positive(),
      fromAddress: z.string().optional(),
      nonce: z.string().min(1, 'nonce is required'),
   })
);

export type TransferRequestBody = z.infer<typeof transferSchema>;

export async function httpTransferCreatorKey(
   req: StellarSignedRequest,
   res: Response
): Promise<void> {
   const body = req.body as TransferRequestBody;
   const senderWallet = req.walletAddress!;
   const keyParam = String(req.params.id || req.params.keyId);

   if (body.fromAddress && body.fromAddress !== senderWallet) {
      sendForbidden(res, 'fromAddress must match authenticated wallet');
      return;
   }

   const toAddressValidation = StellarAddressSchema.safeParse(body.toAddress);
   if (!toAddressValidation.success) {
      sendValidationError(
         res,
         'Invalid recipient Stellar wallet address',
         zodIssuesToDetails(toAddressValidation.error.issues)
      );
      return;
   }

   const creator = await prisma.creatorProfile.findFirst({
      where: { OR: [{ id: keyParam }, { handle: keyParam }] },
      select: { id: true },
   });

   if (!creator) {
      sendNotFound(res, 'Key');
      return;
   }

   const keyId = creator.id;

   try {
      await assertTradingActive(keyId);
   } catch (error) {
      if (error instanceof TradingPausedError) {
         sendError(res, 503, ErrorCode.INTERNAL_ERROR, error.message);
         return;
      }
      throw error;
   }

   try {
      await assertPositionNotFrozen(senderWallet, keyId);
   } catch (error) {
      if (error instanceof PositionFrozenError) {
         sendForbidden(res, error.message);
         return;
      }
      throw error;
   }

   try {
      await assertWalletNotSuspended(senderWallet);
   } catch (error) {
      if (error instanceof WalletSuspendedError) {
         sendForbidden(res, error.message);
         return;
      }
      throw error;
   }

   try {
      const result = await transferKeys(
         keyId,
         senderWallet,
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
         sendError(res, 400, ErrorCode.BAD_REQUEST, error.message);
         return;
      }
      logger.error({ error, keyId, senderWallet }, 'Key transfer failed');
      throw error;
   }
}
