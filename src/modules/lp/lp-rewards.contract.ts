// src/modules/lp/lp-rewards.contract.ts
// On-chain Soroban live rewards reader for LP positions.

import {
   Account,
   Address,
   Contract,
   Networks,
   TransactionBuilder,
   xdr,
} from '@stellar/stellar-base';
import { envConfig } from '../../config';
import {
   defaultSorobanTransport,
   SorobanPostJson,
} from '../../clients/soroban.client';

export class LpContractNotConfiguredError extends Error {
   constructor(message: string = 'LP_CONTRACT_ID is not configured') {
      super(message);
      this.name = 'LpContractNotConfiguredError';
   }
}

export class LpRewardsFetchError extends Error {
   public readonly cause?: unknown;

   constructor(message: string, options?: { cause?: unknown }) {
      super(message);
      this.name = 'LpRewardsFetchError';
      this.cause = options?.cause;
   }
}

function networkPassphrase(): string {
   return envConfig.STELLAR_NETWORK === 'mainnet'
      ? Networks.PUBLIC
      : Networks.TESTNET;
}

/**
 * Builds the arguments for `get_lp_rewards(wallet, keyId)`.
 *
 * NOTE: The argument shape (Address for wallet, Symbol/ScVal for keyId) is an
 * assumption pending confirmation from the contract owners.
 */
export function buildGetLpRewardsArgs(
   wallet: string,
   keyId: string
): [xdr.ScVal, xdr.ScVal] {
   const walletArg = new Address(wallet).toScVal();
   const keyIdArg = xdr.ScVal.scvString(keyId);
   return [walletArg, keyIdArg];
}

/**
 * Builds an unsigned simulated transaction envelope to query `get_lp_rewards(wallet, keyId)`
 * against the LP contract.
 */
export function buildGetLpRewardsViewXdr(
   contractId: string,
   wallet: string,
   keyId: string,
   sequence: string = '0'
): string {
   const args = buildGetLpRewardsArgs(wallet, keyId);
   const operation = new Contract(contractId).call('get_lp_rewards', ...args);

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
 * Decodes a base64 XDR ScVal integer (u32, i32, u64, i64, u128, i128) into a decimal string.
 * Uses BigInt-safe parsing (never Number) to prevent precision loss.
 */
export function decodeLpRewardsScVal(scValXdr: string): string {
   const val = xdr.ScVal.fromXDR(scValXdr, 'base64');
   const type = val.switch();

   if (type === xdr.ScValType.scvU32()) {
      return BigInt(val.u32()).toString();
   }
   if (type === xdr.ScValType.scvI32()) {
      return BigInt(val.i32()).toString();
   }
   if (type === xdr.ScValType.scvU64()) {
      return BigInt(val.u64().toString()).toString();
   }
   if (type === xdr.ScValType.scvI64()) {
      return BigInt(val.i64().toString()).toString();
   }
   if (type === xdr.ScValType.scvU128()) {
      const parts = val.u128() as unknown as {
         hi(): { toString(): string };
         lo(): { toString(): string };
      };
      const hi = BigInt(parts.hi().toString());
      const lo = BigInt.asUintN(64, BigInt(parts.lo().toString()));
      return ((hi << 64n) | lo).toString();
   }
   if (type === xdr.ScValType.scvI128()) {
      const parts = val.i128() as unknown as {
         hi(): { toString(): string };
         lo(): { toString(): string };
      };
      const hi = BigInt(parts.hi().toString());
      const lo = BigInt.asUintN(64, BigInt(parts.lo().toString()));
      return ((hi << 64n) | lo).toString();
   }

   throw new Error(`Unsupported ScValType for LP rewards: ${type.name}`);
}

export interface GetLpRewardsLiveDeps {
   postJson?: SorobanPostJson;
   contractIdOverride?: string;
}

/**
 * Calls contract function `get_lp_rewards` with wallet and keyId, simulates the call
 * on Soroban RPC, and returns the result as a decimal string using BigInt parsing.
 */
export async function getLpRewardsLive(
   wallet: string,
   keyId: string,
   deps?: GetLpRewardsLiveDeps
): Promise<string> {
   const contractId =
      deps?.contractIdOverride ?? envConfig.LP_CONTRACT_ID;
   if (!contractId) {
      throw new LpContractNotConfiguredError();
   }

   const postJson = deps?.postJson ?? defaultSorobanTransport;
   const rpcUrl = envConfig.STELLAR_SOROBAN_RPC_URL;
   if (!rpcUrl) {
      throw new LpRewardsFetchError('STELLAR_SOROBAN_RPC_URL is not configured');
   }

   let txXdr: string;
   try {
      txXdr = buildGetLpRewardsViewXdr(contractId, wallet, keyId);
   } catch (error) {
      throw new LpRewardsFetchError('Failed to build transaction for get_lp_rewards', {
         cause: error,
      });
   }

   const body = {
      jsonrpc: '2.0',
      id: 'get-lp-rewards',
      method: 'simulateTransaction',
      params: {
         transaction: txXdr,
      },
   };

   let envelope: unknown;
   try {
      envelope = await postJson(rpcUrl, body);
   } catch (error) {
      throw new LpRewardsFetchError('RPC request failed for simulateTransaction', {
         cause: error,
      });
   }

   const parsedEnvelope = (envelope ?? {}) as {
      error?: { code?: number; message?: string };
      result?: {
         error?: string;
         results?: Array<{ xdr?: string; retval?: string }>;
      };
   };

   if (parsedEnvelope.error) {
      throw new LpRewardsFetchError(
         `Soroban RPC error: ${parsedEnvelope.error.message ?? 'Unknown error'}`,
         { cause: parsedEnvelope.error }
      );
   }

   if (parsedEnvelope.result?.error) {
      throw new LpRewardsFetchError(
         `Simulation returned error: ${parsedEnvelope.result.error}`,
         { cause: parsedEnvelope.result }
      );
   }

   const returnedXdr =
      parsedEnvelope.result?.results?.[0]?.retval ??
      parsedEnvelope.result?.results?.[0]?.xdr;

   if (!returnedXdr) {
      throw new LpRewardsFetchError(
         'Simulation result is missing or empty in RPC response'
      );
   }

   try {
      return decodeLpRewardsScVal(returnedXdr);
   } catch (error) {
      throw new LpRewardsFetchError('Failed to decode simulation return value', {
         cause: error,
      });
   }
}
