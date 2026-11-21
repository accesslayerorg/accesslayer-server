import { z } from 'zod';
import { StrKey } from '@stellar/stellar-base';

export const AIRDROP_MAX_ALLOCATIONS = 10000;
export const MAX_I128 = (1n << 127n) - 1n;

export const AirdropAddressSchema = z.string().refine(
   address => StrKey.isValidEd25519PublicKey(address),
   'Invalid Stellar account address'
);

export const AirdropAmountSchema = z.string().regex(
   /^[1-9][0-9]{0,38}$/,
   'Amount must be a positive integer string in smallest units'
).refine(amount => {
   try {
      return BigInt(amount) <= MAX_I128;
   } catch {
      return false;
   }
}, 'Amount exceeds signed i128');

export const AllocationSchema = z.object({
   address: AirdropAddressSchema,
   amount: AirdropAmountSchema,
}).strict();

export const AllocationsSchema = z.array(AllocationSchema).min(1).max(AIRDROP_MAX_ALLOCATIONS)
   .superRefine((allocations, ctx) => {
      const addresses = allocations.map(allocation => allocation.address);
      if (new Set(addresses).size !== addresses.length) {
         ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Duplicate allocation addresses are not allowed',
         });
      }
   });

export const CreateAirdropSchema = z.object({
   keyId: z.string().trim().min(1).max(128),
   allocations: AllocationsSchema,
}).strict();

export const AirdropIdSchema = z.string().min(1).max(128);
export const AirdropProofQuerySchema = z.object({
   address: AirdropAddressSchema,
}).strict();

export type Allocation = z.infer<typeof AllocationSchema>;
export type CreateAirdropInput = z.infer<typeof CreateAirdropSchema>;
