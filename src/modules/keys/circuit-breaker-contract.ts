// src/modules/keys/circuit-breaker-contract.ts
// Reads the circuit breaker max_bps configuration from the on-chain contract (#987).
//
// The key contract keeps its circuit breaker configuration in persistent
// contract storage. This module builds the contract-data ledger key for the
// `max_bps` entry, queries it through the shared Soroban RPC helper, and
// decodes the returned ScVal into a basis-points integer.
//
// Reads are best-effort: any RPC or decoding failure resolves to `null` so the
// caller can fall back to the indexed configuration mirror.

import { xdr, Contract } from '@stellar/stellar-base';
import { envConfig } from '../../config';
import { getLedgerEntries } from '../../utils/soroban-rpc.utils';
import { logger } from '../../utils/logger.utils';

/** Persistent-storage data key holding the key's circuit breaker max bps. */
export const CIRCUIT_BREAKER_MAX_BPS_DATA_KEY = 'max_bps';

/**
 * Build the base64 LedgerKey for a contract's `max_bps` contract-data entry.
 * Exported so callers can batch or reuse the key.
 */
export function buildCircuitBreakerConfigLedgerKey(contractId: string): string {
   const contract = new Contract(contractId);
   const ledgerKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
         contract: contract.address().toScAddress(),
         key: xdr.ScVal.scvSymbol(CIRCUIT_BREAKER_MAX_BPS_DATA_KEY),
         durability: xdr.ContractDataDurability.persistent(),
      })
   );
   return ledgerKey.toXDR('base64');
}

/**
 * Decode a base64 LedgerEntry XDR into the circuit breaker max bps integer.
 * Returns null when the entry is not contract data or holds a non-integer value.
 */
export function decodeCircuitBreakerMaxBps(entryXdr: string): number | null {
   try {
      const entry = xdr.LedgerEntry.fromXDR(entryXdr, 'base64');
      const data = entry.data();
      if (data.switch() !== xdr.LedgerEntryType.contractData()) {
         return null;
      }
      return readScValInteger(data.contractData().val());
   } catch (error) {
      logger.debug(
         { error: (error as Error).message },
         'Failed to decode circuit breaker contract data entry'
      );
      return null;
   }
}

/**
 * Read the circuit breaker max bps for a key from the contract.
 *
 * Returns `null` when no contract id is configured, the RPC is unavailable,
 * the entry is missing, or the value cannot be decoded.
 */
export async function fetchCircuitBreakerMaxBpsFromContract(
   keyId: string
): Promise<number | null> {
   const contractId = envConfig.CIRCUIT_BREAKER_CONTRACT_ID;
   if (!contractId) {
      return null;
   }

   try {
      const response = await getLedgerEntries([
         buildCircuitBreakerConfigLedgerKey(contractId),
      ]);
      const entry = response?.entries?.[0];
      if (!entry?.xdr) {
         return null;
      }
      return decodeCircuitBreakerMaxBps(entry.xdr);
   } catch (error) {
      logger.warn(
         { keyId, error: (error as Error).message },
         'Circuit breaker contract read failed; using indexed configuration'
      );
      return null;
   }
}

/** Read an integer from a ScVal, unwrapping a `{ max_bps: N }` map when needed. */
function readScValInteger(scVal: any): number | null {
   const type = scVal.switch();
   if (type === xdr.ScValType.scvU32()) return Number(scVal.u32());
   if (type === xdr.ScValType.scvI32()) return Number(scVal.i32());
   if (type === xdr.ScValType.scvU64()) return toFiniteNumber(scVal.u64().toString());
   if (type === xdr.ScValType.scvI64()) return toFiniteNumber(scVal.i64().toString());
   if (type === xdr.ScValType.scvMap()) {
      const entries = scVal.map() ?? [];
      for (const mapEntry of entries) {
         const name = readScValKeyName(mapEntry.key());
         if (name === 'max_bps' || name === 'maxBps' || name === 'maxbps') {
            return readScValInteger(mapEntry.val());
         }
      }
   }
   return null;
}

function readScValKeyName(scVal: any): string | null {
   try {
      const type = scVal.switch();
      if (type === xdr.ScValType.scvSymbol()) return scVal.sym().toString();
      if (type === xdr.ScValType.scvString()) return scVal.str().toString();
      return null;
   } catch {
      return null;
   }
}

function toFiniteNumber(value: string): number | null {
   const parsed = Number(value);
   return Number.isFinite(parsed) ? parsed : null;
}
