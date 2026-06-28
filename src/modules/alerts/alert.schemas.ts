import { z } from 'zod';
import { isValidStellarAddress } from '../wallet/wallet.utils';

export const CreateAlertSchema = z.object({
    creator_id: z.string().min(1, 'creator_id is required'),
    wallet_address: z
        .string()
        .refine(isValidStellarAddress, { message: 'Invalid Stellar wallet address' }),
    target_price: z
        .number({ invalid_type_error: 'target_price must be a number' })
        .positive('target_price must be positive'),
    direction: z.enum(['above', 'below'], {
        errorMap: () => ({ message: "direction must be 'above' or 'below'" }),
    }),
    callback_url: z.string().url('callback_url must be a valid URL'),
});

export type CreateAlertInput = z.infer<typeof CreateAlertSchema>;

export const ListAlertsQuerySchema = z.object({
    wallet_address: z
        .string()
        .refine(isValidStellarAddress, { message: 'Invalid Stellar wallet address' }),
});

export type ListAlertsQueryType = z.infer<typeof ListAlertsQuerySchema>;

export const AlertParamsSchema = z.object({
    id: z.string().min(1, 'Alert id is required'),
});

export const DeleteAlertBodySchema = z.object({
    wallet_address: z
        .string()
        .refine(isValidStellarAddress, { message: 'Invalid Stellar wallet address' }),
});

export type DeleteAlertBodyType = z.infer<typeof DeleteAlertBodySchema>;
