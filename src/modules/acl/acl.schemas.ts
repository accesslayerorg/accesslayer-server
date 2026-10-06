// src/modules/acl/acl.schemas.ts
// Validation schemas for the ACL whitelist admin API (#966).

import { z } from 'zod';

/**
 * A Soroban contract address (StrKey "contract" flavor): starts with 'C',
 * exactly 56 characters, Base32 (A-Z, 2-7). This is distinct from an
 * account address (which starts with 'G') - the ACL whitelists external
 * *contracts*, not wallets.
 */
export const ContractAddressSchema = z
   .string()
   .length(56, 'Contract address must be exactly 56 characters long')
   .regex(
      /^C[A-Z2-7]{55}$/,
      "Invalid contract address format (must start with 'C' and use Base32 characters)"
   );

/** Max distinct permitted functions accepted per contract. */
export const ACL_MAX_FUNCTIONS = 50;

/**
 * A contract function name: alphanumeric plus underscore, matching Soroban
 * contract function naming rules.
 */
export const FunctionNameSchema = z
   .string()
   .min(1, 'Function name is required')
   .max(64, 'Function name must be at most 64 characters')
   .regex(
      /^[a-zA-Z_][a-zA-Z0-9_]*$/,
      'Function name must be alphanumeric/underscore and cannot start with a digit'
   );

/** A single admin's signature over the ACL action's canonical message. */
export const AclSignatureSchema = z.object({
   wallet: z
      .string()
      .length(56, 'Signer wallet must be exactly 56 characters long')
      .regex(/^G[A-Z2-7]{55}$/, 'Invalid signer wallet address format'),
   signature: z.string().min(1, 'Signature is required'),
});

export type AclSignatureInput = z.infer<typeof AclSignatureSchema>;

/** Body for POST /admin/acl. */
export const AddAclEntryBodySchema = z.object({
   contractAddress: ContractAddressSchema,
   permittedFunctions: z
      .array(FunctionNameSchema)
      .min(1, 'At least one permitted function is required')
      .max(
         ACL_MAX_FUNCTIONS,
         `At most ${ACL_MAX_FUNCTIONS} functions can be whitelisted per contract`
      )
      .transform(fns => Array.from(new Set(fns))),
   signatures: z
      .array(AclSignatureSchema)
      .min(1, 'At least one admin signature is required'),
});

export type AddAclEntryBody = z.infer<typeof AddAclEntryBodySchema>;

/** Params for DELETE /admin/acl/:contractId. */
export const RemoveAclEntryParamsSchema = z.object({
   contractId: z.string().min(1, 'contractId is required'),
});

/** Body for DELETE /admin/acl/:contractId. */
export const RemoveAclEntryBodySchema = z.object({
   signatures: z
      .array(AclSignatureSchema)
      .min(1, 'At least one admin signature is required'),
});

export type RemoveAclEntryBody = z.infer<typeof RemoveAclEntryBodySchema>;

/** Shared page/limit query schema for the list and history endpoints. */
export const AclPaginationQuerySchema = z.object({
   page: z.coerce.number().int().positive().optional().default(1),
   limit: z.coerce.number().int().positive().max(100).optional().default(20),
});

export type AclPaginationQuery = z.infer<typeof AclPaginationQuerySchema>;
