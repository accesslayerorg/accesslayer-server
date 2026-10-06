import { z } from 'zod';
import { isValidStellarAddress } from '../wallet/wallet.utils';

export const CreateAlertSchema = z
   .object({
      keyId: z.string().min(1, 'keyId is required').optional(),
      creator_id: z.string().min(1, 'creator_id is required').optional(),
      creatorId: z.string().min(1, 'creatorId is required').optional(),
      wallet_address: z
         .string()
         .refine(isValidStellarAddress, {
            message: 'Invalid Stellar wallet address',
         })
         .optional(),
      walletAddress: z
         .string()
         .refine(isValidStellarAddress, {
            message: 'Invalid Stellar wallet address',
         })
         .optional(),
      target_price: z
         .number({ invalid_type_error: 'target_price must be a number' })
         .positive('target_price must be positive')
         .optional(),
      targetPrice: z
         .number({ invalid_type_error: 'targetPrice must be a number' })
         .positive('targetPrice must be positive')
         .optional(),
      direction: z.enum(['above', 'below'], {
         errorMap: () => ({ message: "direction must be 'above' or 'below'" }),
      }),
      callback_url: z.string().url('callback_url must be a valid URL').optional(),
      callbackUrl: z.string().url('callbackUrl must be a valid URL').optional(),
   })
   .refine(
      (data) => !!(data.keyId || data.creator_id || data.creatorId),
      {
         message: 'keyId is required',
         path: ['keyId'],
      }
   )
   .refine(
      (data) => data.targetPrice !== undefined || data.target_price !== undefined,
      {
         message: 'targetPrice must be a positive number',
         path: ['targetPrice'],
      }
   )
   .transform((data) => ({
      creator_id: (data.keyId || data.creator_id || data.creatorId)!,
      wallet_address: data.wallet_address || data.walletAddress,
      target_price: (data.targetPrice ?? data.target_price)!,
      direction: data.direction,
      callback_url:
         data.callbackUrl ||
         data.callback_url ||
         'https://accesslayer.org/webhooks/alerts',
   }));

export type CreateAlertInput = {
   creator_id: string;
   wallet_address: string;
   target_price: number;
   direction: 'above' | 'below';
   callback_url: string;
};

export const ListAlertsQuerySchema = z.object({
   wallet_address: z
      .string()
      .refine(isValidStellarAddress, {
         message: 'Invalid Stellar wallet address',
      })
      .optional(),
   walletAddress: z
      .string()
      .refine(isValidStellarAddress, {
         message: 'Invalid Stellar wallet address',
      })
      .optional(),
});

export type ListAlertsQueryType = z.infer<typeof ListAlertsQuerySchema>;

export const AlertParamsSchema = z
   .object({
      id: z.string().optional(),
      alertId: z.string().optional(),
   })
   .refine((data) => !!(data.id || data.alertId), {
      message: 'Alert id is required',
      path: ['id'],
   });

export const DeleteAlertBodySchema = z.object({
   wallet_address: z
      .string()
      .refine(isValidStellarAddress, {
         message: 'Invalid Stellar wallet address',
      })
      .optional(),
   walletAddress: z
      .string()
      .refine(isValidStellarAddress, {
         message: 'Invalid Stellar wallet address',
      })
      .optional(),
});

export type DeleteAlertBodyType = z.infer<typeof DeleteAlertBodySchema>;
