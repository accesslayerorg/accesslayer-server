// src/modules/wallets/wallet-following.schemas.ts
import { z } from 'zod';
import { StellarAddressSchema } from '../wallet/wallet.schemas';

export const WalletFollowingParamsSchema = z.object({
   address: StellarAddressSchema,
});
