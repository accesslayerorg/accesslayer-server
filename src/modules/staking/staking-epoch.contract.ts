// src/modules/staking/staking-epoch.contract.ts
// Live contract reader for get_stake_rewards (#1086).
//
// Builds a Soroban simulateTransaction envelope for the staking contract's
// read-only `get_stake_rewards(wallet, stake_id)` view function and decodes
// the returned i128/u128 ScVal into a stroop-precision decimal string.
//
// Mirrors the pattern established in lp-rewards.contract.ts.

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
import { logger } from '../../utils/logger.utils';

// ── Errors ────────────────────────────────────────────────────

export class StakingContractNotConfiguredError extends Error {
   constructor() {
      super('STAKING_CONTRACT_ID is not configured');
      this.name = 'StakingContractNotConfiguredError';
   }
}

export class StakeRewardsFetchError extends Error {
   public readonly cause?: unknown;
   constructor(message: string, options?: { cause?: unknown }) {
      super(message);
      this.name = 'StakeRewardsFetchError';
      this.cause = options?.cause;
   }
}

// ── Helpers ───────────────────────────────────────────────────

function networkPassphrase(): string {
   return envConfig.STELLAR_NETWORK === 'mainnet'
      ? Networks.PUBLIC
      : Networks.TESTNET;
}

/**
 * Builds the unsigned XDR envelope for `get_stake_rewards(wallet, stakeId)`.
 * The `sequence` defaults to '0' since this is a read-only simulation — no
 * sequence increment is applied on-chain.
 */
export function buildGetStakeRewardsXdr(
   contractId: string,
   wallet: string,
   stakeId: string,
   sequence = '0'
): string {
   const operation = new Contract(contractId).call(
      'get_stake_rewards',
      new Address(wallet).toScVal(),
      xdr.ScVal.scvString(stakeId)
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
 * Decodes a base64 XDR ScVal (u32 / i32 / u64 / i64 / u128 / i128) into a
 * BigInt-safe decimal string. Precision loss is prevented by never casting
 * through Number.
 */
export function decodeStakeRewardsScVal(scValXdr: string): string {
   const val = xdr.ScVal.fromXDR(scValXdr, 'base64');
   const t = val.switch();

   if (t === xdr.ScValType.scvU32()) return BigInt(val.u32()).toString();
   if (t === xdr.ScValType.scvI32()) return BigInt(val.i32()).toString();

   if (t === xdr.ScValType.scvU64())
      return BigInt(val.u64().toString()).toString();
   if (t === xdr.ScValType.scvI64())
      return BigInt(val.i64().toString()).toString();

   if (t === xdr.ScValType.scvU128()) {
      const p = val.u128() as unknown as {
         hi(): { toString(): string };
         lo(): { toString(): string };
      };
      return (
         (BigInt(p.hi().toString()) << 64n) |
         BigInt.asUintN(64, BigInt(p.lo().toString()))
      ).toString();
   }

   if (t === xdr.ScValType.scvI128()) {
      const p = val.i128() as unknown as {
         hi(): { toString(): string };
         lo(): { toString(): string };
      };
      return (
         (BigInt(p.hi().toString()) << 64n) |
         BigInt.asUintN(64, BigInt(p.lo().toString()))
      ).toString();
   }

   throw new StakeRewardsFetchError(
      `Unsupported ScValType for stake rewards: ${t.name}`
   );
}

// ── Public API ────────────────────────────────────────────────

export interface GetStakeRewardsDeps {
   postJson?: SorobanPostJson;
   /** Override contract ID (useful in tests). */
   contractIdOverride?: string;
}

/**
 * Calls `get_stake_rewards(wallet, stakeId)` against the staking contract via
 * Soroban RPC simulation and returns the accrued rewards as a decimal string
 * in stroops.
 *
 * Throws {@link StakingContractNotConfiguredError} when the contract ID env
 * var is missing, or {@link StakeRewardsFetchError} on any RPC/decode failure.
 */
export async function getStakeRewardsLive(
   wallet: string,
   stakeId: string,
   deps?: GetStakeRewardsDeps
): Promise<string> {
   const contractId =
      deps?.contractIdOverride ?? envConfig.STAKING_CONTRACT_ID;
   if (!contractId) {
      throw new StakingContractNotConfiguredError();
   }

   const postJson = deps?.postJson ?? defaultSorobanTransport;
   const rpcUrl = envConfig.STELLAR_SOROBAN_RPC_URL;
   if (!rpcUrl) {
      throw new StakeRewardsFetchError('STELLAR_SOROBAN_RPC_URL is not configured');
   }

   let txXdr: string;
   try {
      txXdr = buildGetStakeRewardsXdr(contractId, wallet, stakeId);
   } catch (error) {
      throw new StakeRewardsFetchError(
         'Failed to build transaction for get_stake_rewards',
         { cause: error }
      );
   }

   let envelope: unknown;
   try {
      envelope = await postJson(rpcUrl, {
         jsonrpc: '2.0',
         id: 'get-stake-rewards',
         method: 'simulateTransaction',
         params: { transaction: txXdr },
      });
   } catch (error) {
      throw new StakeRewardsFetchError(
         'RPC request failed for get_stake_rewards',
         { cause: error }
      );
   }

   const parsed = (envelope ?? {}) as {
      error?: { code?: number; message?: string };
      result?: {
         error?: string;
         results?: Array<{ xdr?: string; retval?: string }>;
      };
   };

   if (parsed.error) {
      throw new StakeRewardsFetchError(
         `Soroban RPC error: ${parsed.error.message ?? 'unknown'}`,
         { cause: parsed.error }
      );
   }

   if (parsed.result?.error) {
      throw new StakeRewardsFetchError(
         `Simulation returned error: ${parsed.result.error}`,
         { cause: parsed.result }
      );
   }

   const returnedXdr =
      parsed.result?.results?.[0]?.retval ??
      parsed.result?.results?.[0]?.xdr;

   if (!returnedXdr) {
      throw new StakeRewardsFetchError(
         'Simulation result missing in RPC response'
      );
   }

   try {
      const rewards = decodeStakeRewardsScVal(returnedXdr);
      logger.debug(
         { wallet, stakeId, rewards },
         'get_stake_rewards simulation decoded'
      );
      return rewards;
   } catch (error) {
      throw new StakeRewardsFetchError(
         'Failed to decode get_stake_rewards return value',
         { cause: error }
      );
   }
}
