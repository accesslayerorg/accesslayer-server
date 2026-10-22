// src/modules/badges/badge-mint.builder.ts
// Builds and signs the `mint_badge(wallet, badge_type)` Soroban transaction.

import {
   Account,
   Address,
   Contract,
   Keypair,
   Networks,
   TransactionBuilder,
   xdr,
} from '@stellar/stellar-base';
import { envConfig } from '../../config';
import type { BadgeType } from './badge.types';

/** Raised when the badge contract or minter key is not configured. */
export class BadgeContractUnavailableError extends Error {
   constructor(message = 'Badge minting is not configured') {
      super(message);
      this.name = 'BadgeContractUnavailableError';
   }
}

function networkPassphrase(): string {
   return envConfig.STELLAR_NETWORK === 'mainnet'
      ? Networks.PUBLIC
      : Networks.TESTNET;
}

/**
 * Build a signed Soroban transaction that invokes
 * `mint_badge(recipient: Address, badge_type: Symbol)` on the configured badge
 * contract, signed by the server's badge minter keypair.
 *
 * @throws {BadgeContractUnavailableError} when BADGE_CONTRACT_ID or
 *         BADGE_MINTER_SECRET is missing.
 */
export function buildMintBadgeTransaction(
   wallet: string,
   badgeType: BadgeType
): string {
   const contractId = envConfig.BADGE_CONTRACT_ID;
   const minterSecret = envConfig.BADGE_MINTER_SECRET;
   if (!contractId || !minterSecret) {
      throw new BadgeContractUnavailableError(
         'BADGE_CONTRACT_ID and BADGE_MINTER_SECRET must be set to mint badges'
      );
   }

   const minter = Keypair.fromSecret(minterSecret);
   const contract = new Contract(contractId);
   const recipient = new Address(wallet);

   const op = contract.call(
      'mint_badge',
      recipient.toScVal(),
      xdr.ScVal.scvSymbol(badgeType)
   );

   // Sequence 0 placeholder: the submission pipeline / RPC assigns the real
   // sequence. Mirrors the unsigned-builder pattern used elsewhere in the repo.
   const tx = new TransactionBuilder(new Account(minter.publicKey(), '0'), {
      fee: '100',
      networkPassphrase: networkPassphrase(),
   })
      .addOperation(op)
      .setTimeout(300)
      .build();

   tx.sign(minter);

   return tx.toXDR();
}
