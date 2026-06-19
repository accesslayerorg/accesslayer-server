import { z } from 'zod';
import { StellarAddressSchema } from '../wallet/wallet.schemas';

export const AlertDirectionEnum = z.enum(['above', 'below']);

export const CreateAlertSchema = z.object({
  creator_id: z.string().min(1, 'creator_id is required'),
  wallet_address: StellarAddressSchema,
  target_price: z
    .union([z.string(), z.number()])
    .transform((v) => String(v))
    .refine((v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0;
    }, 'target_price must be a positive number'),
  direction: AlertDirectionEnum,
  callback_url: z.string().url('callback_url must be a valid URL'),
});

export type CreateAlertType = z.infer<typeof CreateAlertSchema>;
