import { z } from 'zod';

const CONTRACT_OPERATION_VALUES = [
   'buy',
   'sell',
   'stake',
   'governance',
   'claim',
] as const;

export const SubmitContractCallSchema = z.object({
   operation: z.enum(CONTRACT_OPERATION_VALUES, {
      message:
         'operation must be one of: buy, sell, stake, governance, claim',
   }),
   /** Wallet that requested the submission (tracking/audit context). */
   submitter_wallet: z
      .string()
      .min(1, 'submitter_wallet is required'),
   /** Base64 XDR of the fully signed transaction envelope. */
   transaction_xdr: z
      .string()
      .min(1, 'transaction_xdr is required'),
});

export type SubmitContractCallBody = z.infer<typeof SubmitContractCallSchema>;
