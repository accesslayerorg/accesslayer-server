import { z } from 'zod';

const STELLAR_ACCOUNT = /^G[A-Z2-7]{55}$/;

export const keyLpWalletParamsSchema = z.object({
   keyId: z.string().trim().min(1, 'keyId is required').max(128),
   wallet: z
      .string()
      .trim()
      .regex(STELLAR_ACCOUNT, 'wallet must be a Stellar account address'),
});

export type KeyLpWalletParams = z.infer<typeof keyLpWalletParamsSchema>;
