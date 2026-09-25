import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
   sendSuccess,
   sendValidationError,
   sendConflict,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   registerKeyContract,
   DuplicateKeyAddressError,
   InvalidOnChainKeyError,
} from './key-registration.service';

/**
 * Zod validation schema for POST /keys/register request body.
 * Supports both `keyAddress` and `contractAddress` parameters.
 */
export const registerKeyRequestSchema = z
   .object({
      keyAddress: z.string().optional(),
      contractAddress: z.string().optional(),
      creatorWallet: z
         .string({ required_error: 'creatorWallet is required' })
         .min(1, 'creatorWallet cannot be empty'),
      metadata: z.record(z.unknown()).optional().default({}),
   })
   .refine(
      data =>
         Boolean(
            (data.keyAddress && data.keyAddress.trim().length > 0) ||
            (data.contractAddress && data.contractAddress.trim().length > 0)
         ),
      {
         message: 'keyAddress or contractAddress is required',
         path: ['keyAddress'],
      }
   )
   .transform(data => ({
      keyAddress: (data.keyAddress || data.contractAddress || '').trim(),
      creatorWallet: data.creatorWallet.trim(),
      metadata: data.metadata || {},
   }));

/**
 * Controller for POST /keys/register.
 * Endpoint invoked by internal factory indexer to register newly deployed contract addresses.
 */
export async function httpRegisterKey(
   req: Request,
   res: Response,
   next: NextFunction
): Promise<void> {
   try {
      const parseResult = registerKeyRequestSchema.safeParse(req.body);
      if (!parseResult.success) {
         sendValidationError(
            res,
            'Invalid request payload',
            zodIssuesToDetails(parseResult.error.issues)
         );
         return;
      }

      const { keyAddress, creatorWallet, metadata } = parseResult.data;

      const registeredKey = await registerKeyContract({
         keyAddress,
         creatorWallet,
         metadata,
      });

      sendSuccess(res, registeredKey, 201, 'Key registered successfully');
   } catch (error) {
      if (error instanceof DuplicateKeyAddressError) {
         sendConflict(res, error.message);
         return;
      }
      if (error instanceof InvalidOnChainKeyError) {
         sendValidationError(res, error.message, [
            { field: 'keyAddress', message: error.message },
         ]);
         return;
      }
      next(error);
   }
}
