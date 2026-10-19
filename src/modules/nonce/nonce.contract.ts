// src/modules/nonce/nonce.contract.ts
// On-chain Soroban Nonce Registry contract interaction (#1039).

import {
   Account,
   Address,
   Contract,
   Networks,
   TransactionBuilder,
   xdr,
} from '@stellar/stellar-base';
import { envConfig } from '../../config';
import { logger } from '../../utils/logger.utils';
import type { NonceContractProvider } from './nonce.types';

const trackedOnChainNonces = new Map<string, number>();

export function getTrackedOnChainNonce(wallet: string): number {
   return trackedOnChainNonces.get(wallet) ?? 0;
}

export function setTrackedOnChainNonce(wallet: string, nonce: number): void {
   trackedOnChainNonces.set(wallet, nonce);
}

export function resetTrackedOnChainNonces(): void {
   trackedOnChainNonces.clear();
}

function networkPassphrase(): string {
   return envConfig.STELLAR_NETWORK === 'mainnet'
      ? Networks.PUBLIC
      : Networks.TESTNET;
}

/**
 * Builds an unsigned simulated transaction envelope to query `get_nonce(wallet)`
 * on the on-chain nonce registry contract.
 */
export function buildNonceViewXdr(
   contractId: string,
   wallet: string,
   sequence: string = '0'
): string {
   const operation = new Contract(contractId).call(
      'get_nonce',
      new Address(wallet).toScVal()
   );
   return new TransactionBuilder(new Account(wallet, sequence), {
      fee: '100',
      networkPassphrase: networkPassphrase(),
   })
      .addOperation(operation)
      .setTimeout(300)
      .build()
      .toXDR();
}

/**
 * Decodes a base64 XDR ScVal returned from `get_nonce` simulation into an integer.
 */
export function decodeNonceScVal(scValXdr: string): number | null {
   try {
      const val = xdr.ScVal.fromXDR(scValXdr, 'base64');
      const type = val.switch();
      if (type === xdr.ScValType.scvU32()) return val.u32();
      if (type === xdr.ScValType.scvI32()) return val.i32();
      if (type === xdr.ScValType.scvU64()) {
         return Number(val.u64().toString());
      }
      if (type === xdr.ScValType.scvI64()) {
         return Number(val.i64().toString());
      }
      if (type === xdr.ScValType.scvU128()) {
         const parts = val.u128() as unknown as {
            lo(): { toString(): string };
         };
         return Number(parts.lo().toString());
      }
      return null;
   } catch (error) {
      logger.debug(
         { error: (error as Error).message },
         'Failed to decode nonce ScVal'
      );
      return null;
   }
}

/**
 * Fetches the wallet's current nonce directly from the Soroban RPC by simulating
 * a `get_nonce` call against `NONCE_REGISTRY_CONTRACT_ID`.
 *
 * Returns `null` if the contract is not configured, RPC is unreachable, or response
 * cannot be decoded, allowing fallback to tracked state.
 */
export async function fetchNonceFromContract(
   wallet: string,
   contractIdOverride?: string
): Promise<number | null> {
   const contractId =
      contractIdOverride ?? (envConfig as any).NONCE_REGISTRY_CONTRACT_ID;
   if (!contractId || !envConfig.STELLAR_SOROBAN_RPC_URL) {
      return null;
   }

   const controller = new AbortController();
   const timeout = setTimeout(
      () => controller.abort(),
      envConfig.DB_QUERY_TIMEOUT_MS
   );

   try {
      const response = await fetch(envConfig.STELLAR_SOROBAN_RPC_URL, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'get-wallet-nonce',
            method: 'simulateTransaction',
            params: {
               transaction: buildNonceViewXdr(contractId, wallet),
            },
         }),
         signal: controller.signal,
      });

      if (!response.ok) {
         logger.warn(
            { status: response.status, wallet },
            'Soroban RPC returned non-200 while querying nonce contract'
         );
         return null;
      }

      const envelope = (await response.json()) as {
         error?: { message?: string };
         result?: {
            results?: Array<{ xdr?: string; retval?: string }>;
         };
      };

      if (envelope.error) {
         logger.warn(
            { error: envelope.error, wallet },
            'Soroban RPC error while simulating get_nonce'
         );
         return null;
      }

      const returnedXdr =
         envelope.result?.results?.[0]?.retval ??
         envelope.result?.results?.[0]?.xdr;

      if (!returnedXdr) {
         return null;
      }

      return decodeNonceScVal(returnedXdr);
   } catch (error) {
      logger.warn(
         { error: (error as Error).message, wallet },
         'Failed to query on-chain nonce registry contract'
      );
      return null;
   } finally {
      clearTimeout(timeout);
   }
}

/**
 * Default contract provider: queries the on-chain contract when configured,
 * falling back to the tracked in-memory/simulated on-chain nonce state.
 */
export const defaultNonceContractProvider: NonceContractProvider = {
   async getWalletNonce(wallet: string): Promise<number> {
      const onChain = await fetchNonceFromContract(wallet);
      if (onChain !== null) {
         return onChain;
      }
      return getTrackedOnChainNonce(wallet);
   },
};
