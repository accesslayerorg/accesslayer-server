// src/modules/acl/acl.service.ts
// On-chain ACL whitelist management (#966).
//
// Controls which external contracts are permitted to interact with the
// platform, and which functions each is permitted to call. Every mutation
// (add or remove) requires a 2-of-3 admin multisig - Ed25519 signatures
// from distinct configured admin wallets over a canonical message binding
// the signature to the exact action - following the same pattern used for
// key deprecation (see keys/key-deprecation.service.ts).

import { createHash } from 'crypto';
import { Keypair } from '@stellar/stellar-base';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { createAuditEntry } from '../admin/audit-log.service';
import {
   parseMultisigAdminWallets,
   MultisigVerificationError,
} from '../keys/key-deprecation.service';

export { MultisigVerificationError };

/** Minimum number of distinct admin signatures required for an ACL mutation. */
export const ACL_MULTISIG_THRESHOLD = 2;
/** The admin quorum size the threshold is expressed against (2 of 3). */
export const ACL_MULTISIG_SET_SIZE = 3;

export interface AclSignature {
   wallet: string;
   signature: string;
}

export class AclEntryAlreadyExistsError extends Error {
   constructor(contractAddress: string) {
      super(`Contract is already whitelisted: ${contractAddress}`);
      this.name = 'AclEntryAlreadyExistsError';
   }
}

export class AclEntryNotFoundError extends Error {
   constructor(contractId: string) {
      super(`Whitelist entry not found: ${contractId}`);
      this.name = 'AclEntryNotFoundError';
   }
}

const STELLAR_ADDRESS_PATTERN = /^G[A-Z2-7]{55}$/;

/**
 * Canonical message each admin signs for an ACL mutation:
 *   SHA256("acl:<action>:<contractAddress>:<sortedFunctions.join(',')>")
 * Binds the signature to the exact action, contract, and function set so a
 * signature can't be replayed against a different contract or function list.
 */
export function buildAclCanonicalMessage(
   action: 'add' | 'remove',
   contractAddress: string,
   permittedFunctions: string[]
): Buffer {
   const sortedFunctions = [...permittedFunctions].sort().join(',');
   const payload = `acl:${action}:${contractAddress}:${sortedFunctions}`;
   return createHash('sha256').update(payload, 'utf8').digest();
}

/**
 * Verify submitted ACL signatures against the canonical message for the
 * given action. Enforces the 2-of-3 multisig threshold: at least two
 * distinct valid signatures, each from a wallet in the configured admin
 * quorum when ADMIN_MULTISIG_WALLETS is set.
 *
 * @throws {MultisigVerificationError} on invalid, duplicate-threshold, or
 * non-admin signers.
 */
export function verifyAclSignatures(params: {
   action: 'add' | 'remove';
   contractAddress: string;
   permittedFunctions: string[];
   signatures: AclSignature[];
}): { validWallets: string[] } {
   const message = buildAclCanonicalMessage(
      params.action,
      params.contractAddress,
      params.permittedFunctions
   );
   const adminWallets = parseMultisigAdminWallets();
   const adminSet = new Set(adminWallets.map(wallet => wallet.toLowerCase()));

   const seen = new Set<string>();
   const validWallets: string[] = [];

   for (const { wallet, signature } of params.signatures) {
      const normalized = wallet.trim();
      const lower = normalized.toLowerCase();
      if (seen.has(lower)) {
         continue; // duplicate wallet signatures count once
      }

      if (!STELLAR_ADDRESS_PATTERN.test(normalized)) {
         throw new MultisigVerificationError(
            `Invalid admin wallet address: ${normalized}`
         );
      }
      if (adminSet.size > 0 && !adminSet.has(lower)) {
         throw new MultisigVerificationError(
            `Signer ${normalized} is not a configured admin`
         );
      }

      let verified = false;
      try {
         const signatureBuffer = Buffer.from(signature, 'base64');
         if (signatureBuffer.length === 64) {
            verified = Keypair.fromPublicKey(normalized).verify(
               message,
               signatureBuffer
            );
         }
      } catch {
         verified = false;
      }
      if (!verified) {
         throw new MultisigVerificationError(
            `Invalid admin signature from ${normalized}`
         );
      }

      seen.add(lower);
      validWallets.push(normalized);
   }

   if (adminSet.size > 0 && adminSet.size !== ACL_MULTISIG_SET_SIZE) {
      throw new MultisigVerificationError(
         `ADMIN_MULTISIG_WALLETS must contain exactly ${ACL_MULTISIG_SET_SIZE} wallets (got ${adminSet.size})`
      );
   }
   if (validWallets.length < ACL_MULTISIG_THRESHOLD) {
      throw new MultisigVerificationError(
         `ACL mutations require ${ACL_MULTISIG_THRESHOLD} of ${adminSet.size || ACL_MULTISIG_SET_SIZE} admin signatures; got ${validWallets.length}`
      );
   }

   return { validWallets };
}

export interface PageResult<T> {
   items: T[];
   page: number;
   limit: number;
   totalCount: number;
   totalPages: number;
}

/**
 * Paginated list of whitelisted contracts with their permitted function
 * sets, newest first.
 */
export async function listAclWhitelist(
   page: number,
   limit: number
): Promise<PageResult<{
   id: string;
   contractAddress: string;
   permittedFunctions: string[];
   addedBy: string;
   createdAt: Date;
   updatedAt: Date;
}>> {
   const [items, totalCount] = await Promise.all([
      prisma.aclWhitelist.findMany({
         orderBy: { createdAt: 'desc' },
         skip: (page - 1) * limit,
         take: limit,
      }),
      prisma.aclWhitelist.count(),
   ]);

   return {
      items,
      page,
      limit,
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / limit)),
   };
}

export interface AddAclEntryInput {
   contractAddress: string;
   permittedFunctions: string[];
   signatures: AclSignature[];
   actor: string;
}

/**
 * Add a contract to the on-chain ACL whitelist with its permitted
 * functions. Verifies the 2-of-3 admin multisig, rejects duplicates, and
 * records both the whitelist row and an audit event in one transaction.
 *
 * TODO: submit the whitelist_contract contract call via the Stellar SDK;
 * on-chain failure should return 502 before this point. The DB row is the
 * off-chain read model, kept in sync with on-chain state by the indexer.
 */
export async function addAclEntry(input: AddAclEntryInput) {
   const { validWallets } = verifyAclSignatures({
      action: 'add',
      contractAddress: input.contractAddress,
      permittedFunctions: input.permittedFunctions,
      signatures: input.signatures,
   });

   const existing = await prisma.aclWhitelist.findUnique({
      where: { contractAddress: input.contractAddress },
   });
   if (existing) {
      throw new AclEntryAlreadyExistsError(input.contractAddress);
   }

   logger.info(
      {
         operation: 'whitelist_contract',
         contractAddress: input.contractAddress,
         permittedFunctions: input.permittedFunctions,
      },
      'Submitting whitelist_contract contract call'
   );

   const metadata = {
      contractAddress: input.contractAddress,
      permittedFunctions: input.permittedFunctions,
      signers: validWallets,
   };

   const [entry] = await prisma.$transaction([
      prisma.aclWhitelist.create({
         data: {
            contractAddress: input.contractAddress,
            permittedFunctions: input.permittedFunctions,
            addedBy: input.actor,
         },
      }),
      prisma.aclEvent.create({
         data: {
            eventType: 'added',
            contractAddress: input.contractAddress,
            permittedFunctions: input.permittedFunctions,
            actor: input.actor,
            signers: validWallets,
         },
      }),
   ]);

   await createAuditEntry({
      actorWallet: input.actor,
      actionType: 'acl_contract_added',
      targetId: entry.id,
      payload: metadata,
   });

   return entry;
}

export interface RemoveAclEntryInput {
   contractId: string;
   signatures: AclSignature[];
   actor: string;
}

/**
 * Remove a contract from the on-chain ACL whitelist. `contractId` may be
 * either the whitelist row id or the contract address itself. Verifies the
 * 2-of-3 admin multisig against the entry's current function set before
 * removing it, and records the removal in the audit event log.
 *
 * TODO: submit the revoke_contract contract call via the Stellar SDK;
 * on-chain failure should return 502 before this point.
 */
export async function removeAclEntry(input: RemoveAclEntryInput) {
   const existing = await prisma.aclWhitelist.findFirst({
      where: {
         OR: [{ id: input.contractId }, { contractAddress: input.contractId }],
      },
   });
   if (!existing) {
      throw new AclEntryNotFoundError(input.contractId);
   }

   const { validWallets } = verifyAclSignatures({
      action: 'remove',
      contractAddress: existing.contractAddress,
      permittedFunctions: existing.permittedFunctions,
      signatures: input.signatures,
   });

   logger.info(
      {
         operation: 'revoke_contract',
         contractAddress: existing.contractAddress,
      },
      'Submitting revoke_contract contract call'
   );

   const metadata = {
      contractAddress: existing.contractAddress,
      permittedFunctions: existing.permittedFunctions,
      signers: validWallets,
   };

   await prisma.$transaction([
      prisma.aclWhitelist.delete({ where: { id: existing.id } }),
      prisma.aclEvent.create({
         data: {
            eventType: 'removed',
            contractAddress: existing.contractAddress,
            permittedFunctions: existing.permittedFunctions,
            actor: input.actor,
            signers: validWallets,
         },
      }),
   ]);

   await createAuditEntry({
      actorWallet: input.actor,
      actionType: 'acl_contract_removed',
      targetId: existing.id,
      payload: metadata,
   });

   return existing;
}

/** Paginated add/remove event log, newest first. */
export async function getAclHistory(page: number, limit: number): Promise<
   PageResult<{
      id: string;
      eventType: string;
      contractAddress: string;
      permittedFunctions: string[];
      actor: string;
      signers: string[];
      createdAt: Date;
   }>
> {
   const [items, totalCount] = await Promise.all([
      prisma.aclEvent.findMany({
         orderBy: { createdAt: 'desc' },
         skip: (page - 1) * limit,
         take: limit,
      }),
      prisma.aclEvent.count(),
   ]);

   return {
      items,
      page,
      limit,
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / limit)),
   };
}
