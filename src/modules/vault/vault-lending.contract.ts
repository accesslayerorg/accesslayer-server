// src/modules/vault/vault-lending.contract.ts
// On-chain boundary for the lending vault.
//
// Reads simulate the contract's `get_health` view (never sign or broadcast) and
// return null when the contract is unconfigured, the wallet has no open
// position, or the value cannot be decoded — the keeper treats null as "already
// liquidated / cannot verify" and skips. Liquidations are built and signed with
// the keeper keypair, then routed through the centralised contract service so
// retries, tracking and resolution events apply like every other server call.

import {
   Account,
   Address,
   Contract,
   Keypair,
   Networks,
   TransactionBuilder,
   scValToNative,
   xdr,
} from '@stellar/stellar-base';
import { envConfig } from '../../config';
import { defaultSorobanTransport } from '../../clients/soroban.client';
import { logger } from '../../utils/logger.utils';

/** Raised when the lending contract or keeper key is not configured. */
export class VaultLendingUnavailableError extends Error {
   constructor(message = 'Lending vault is not configured') {
      super(message);
      this.name = 'VaultLendingUnavailableError';
   }
}

function networkPassphrase(): string {
   return envConfig.STELLAR_NETWORK === 'mainnet'
      ? Networks.PUBLIC
      : Networks.TESTNET;
}

/** Read a position's health factor from the chain; null when unavailable. */
export async function readVaultHealthOnChain(
   wallet: string
): Promise<number | null> {
   const contractId = envConfig.VAULT_LENDING_CONTRACT_ID;
   if (!contractId) return null;

   try {
      const transaction = new TransactionBuilder(new Account(wallet, '0'), {
         fee: '100',
         networkPassphrase: networkPassphrase(),
      })
         .addOperation(
            new Contract(contractId).call(
               'get_health',
               new Address(wallet).toScVal()
            )
         )
         .setTimeout(300)
         .build()
         .toXDR();

      const envelope = (await defaultSorobanTransport(
         envConfig.STELLAR_SOROBAN_RPC_URL,
         {
            jsonrpc: '2.0',
            id: 'get_health',
            method: 'simulateTransaction',
            params: { transaction },
         }
      )) as {
         error?: unknown;
         result?: {
            error?: unknown;
            results?: { xdr?: string; retval?: string }[];
         };
      };

      const result = envelope.result;
      const value = result?.results?.[0]?.xdr ?? result?.results?.[0]?.retval;
      if (envelope.error || result?.error || !value) return null;

      return toHealthValue(scValToNative(xdr.ScVal.fromXDR(value, 'base64')));
   } catch (error) {
      logger.warn(
         { wallet, err: (error as Error).message },
         'vault-lending: on-chain health read failed'
      );
      return null;
   }
}

/** Unwrap a decoded health factor from a number, string, bigint or map. */
function toHealthValue(value: unknown): number | null {
   if (typeof value === 'number') return Number.isFinite(value) ? value : null;
   if (typeof value === 'bigint') return Number(value);
   if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
   }
   if (value && typeof value === 'object') {
      const row = value as Record<string, unknown>;
      return toHealthValue(
         row.health ?? row.health_factor ?? row.healthFactor
      );
   }
   return null;
}

/** Build and sign the keeper's `liquidate(wallet)` transaction. */
export function buildLiquidateTransaction(wallet: string): string {
   const contractId = envConfig.VAULT_LENDING_CONTRACT_ID;
   const keeperSecret = envConfig.LIQUIDATION_KEEPER_SECRET;
   if (!contractId || !keeperSecret) {
      throw new VaultLendingUnavailableError(
         'VAULT_LENDING_CONTRACT_ID and LIQUIDATION_KEEPER_SECRET must be set to liquidate'
      );
   }

   const keeper = Keypair.fromSecret(keeperSecret);
   const op = new Contract(contractId).call(
      'liquidate',
      new Address(wallet).toScVal()
   );

   // Sequence 0 placeholder: the submission pipeline / RPC assigns the real
   // sequence, mirroring the badge-minter builder.
   const tx = new TransactionBuilder(new Account(keeper.publicKey(), '0'), {
      fee: '100',
      networkPassphrase: networkPassphrase(),
   })
      .addOperation(op)
      .setTimeout(300)
      .build();

   tx.sign(keeper);
   return tx.toXDR();
}

/** Submit the keeper's liquidate call and throw unless it confirms. */
export async function submitLiquidate(wallet: string): Promise<void> {
   const transactionXdr = buildLiquidateTransaction(wallet);

   // Lazy import mirrors badge-mint.client to avoid a static import cycle.
   const { submitContractCall } = await import('../contracts/contract.service');
   const result = await submitContractCall(
      { operation: 'liquidate', submitterWallet: wallet, transactionXdr },
      {}
   );

   if (result.status !== 'CONFIRMED') {
      throw new VaultLendingUnavailableError(
         result.lastError || 'liquidate failed'
      );
   }
}
