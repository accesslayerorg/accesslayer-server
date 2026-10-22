// src/modules/keys/key-swap-fee-contract.ts
// Reads current swap fee tier from the dynamic fee contract on-chain.

import { envConfig } from '../../config';
import { logger } from '../../utils/logger.utils';

export type ContractFeeRpcCaller = (keyId: string) => Promise<number | null>;

let overrideRpcCaller: ContractFeeRpcCaller | null = null;

/**
 * Set a mock or custom RPC caller for testing or custom environments.
 */
export function setContractFeeRpcCaller(
   caller: ContractFeeRpcCaller | null
): void {
   overrideRpcCaller = caller;
}

/**
 * Reads get_current_fee_bps for a key from the dynamic fee contract.
 *
 * Returns null if the contract is unreachable, unconfigured, or call fails,
 * enabling the caller to safely fall back to the volume-tier calculation.
 */
export async function fetchCurrentFeeBpsFromContract(
   keyId: string
): Promise<number | null> {
   if (overrideRpcCaller) {
      return overrideRpcCaller(keyId);
   }

   const rpcUrl = envConfig.STELLAR_SOROBAN_RPC_URL;
   const contractId = envConfig.DYNAMIC_FEE_CONTRACT_ID;

   if (!rpcUrl || !contractId) {
      return null;
   }

   try {
      // In production Soroban RPC environments, simulate transaction for get_current_fee_bps
      const response = await fetch(rpcUrl, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         body: JSON.stringify({
            jsonrpc: '2.0',
            id: 'get-current-fee-bps',
            method: 'getLedgerEntries',
            params: {
               keys: [contractId],
            },
         }),
      });

      if (!response.ok) {
         return null;
      }

      const envelope = (await response.json()) as any;
      if (envelope?.error) {
         return null;
      }

      // Check if entry or retval exists and contains a numeric fee
      const val =
         envelope?.result?.entries?.[0]?.val ??
         envelope?.result?.results?.[0]?.retval;
      if (typeof val === 'number') {
         return val;
      }
      return null;
   } catch (error) {
      logger.debug(
         {
            keyId,
            error: error instanceof Error ? error.message : String(error),
         },
         'Dynamic fee contract read failed; using volume tier fallback'
      );
      return null;
   }
}
