// src/modules/badges/badge-mint.client.ts
// Default on-chain client that mints badges through the centralised Soroban
// contract interaction service (#899). Keeping minting behind that pipeline
// means submission retries, transaction tracking, and resolution events are
// applied uniformly, exactly like every other contract call the server makes.

import { logger } from '../../utils/logger.utils';
import type { ContractErrorKind } from '../contracts/contract.types';
import { buildMintBadgeTransaction } from './badge-mint.builder';
import type { BadgeMintContractClient, BadgeType } from './badge.types';

/**
 * Failure returned by the minting pipeline. `kind` lets the service decide
 * whether another attempt could succeed (`transient`) or not (`user`).
 */
export class BadgeMintSubmitError extends Error {
   constructor(
      message: string,
      public readonly kind: ContractErrorKind
   ) {
      super(message);
      this.name = 'BadgeMintSubmitError';
   }
}

/** Production client: builds, signs, and submits the mint_badge call. */
export class DefaultBadgeMintContractClient implements BadgeMintContractClient {
   async mintBadge(
      wallet: string,
      badgeType: BadgeType
   ): Promise<{ txHash?: string }> {
      logger.info(
         { wallet, badgeType, operation: 'mint_badge' },
         'Submitting mint_badge contract call'
      );

      const transactionXdr = buildMintBadgeTransaction(wallet, badgeType);

      // Imported lazily to mirror invoice-market.service and avoid a static
      // import cycle with the contracts module.
      const { submitContractCall } =
         await import('../contracts/contract.service');

      const result = await submitContractCall(
         {
            operation: 'mint_badge',
            submitterWallet: wallet,
            transactionXdr,
         },
         {}
      );

      if (result.status === 'CONFIRMED') {
         return { txHash: result.txHash };
      }

      // A FAILED resolution still returns (rather than throws); surface it as a
      // typed error so the service's retry loop can classify it.
      throw new BadgeMintSubmitError(result.lastError, result.errorKind);
   }

   async mint_badge(
      wallet: string,
      badge_type: BadgeType
   ): Promise<{ txHash?: string }> {
      return this.mintBadge(wallet, badge_type);
   }
}

export function makeDefaultBadgeMintContractClient(): BadgeMintContractClient {
   return new DefaultBadgeMintContractClient();
}

export const defaultBadgeMintContractClient =
   makeDefaultBadgeMintContractClient();
