// src/modules/keys/key-gate-config-contract.ts
// Reads the key content gate configuration from the on-chain contract (#1150).
//
// The contract stores per-key gate configuration in persistent storage.
// This module builds the ledger key, queries via Soroban RPC, and decodes
// the returned ScVal into { gate_type, requirement_params }.

import { xdr, Contract } from '@stellar/stellar-base';
import { envConfig } from '../../config';
import { getLedgerEntries } from '../../utils/soroban-rpc.utils';
import { logger } from '../../utils/logger.utils';

export const GATE_CONFIG_DATA_KEY = 'gate_config';

export type GateType = 'HOLDER' | 'SUBSCRIBER' | 'THRESHOLD';

export interface GateConfigOnChain {
   gateType: GateType;
   requirementParams: Record<string, unknown>;
}

/**
 * Build the base64 LedgerKey for a contract's gate configuration entry.
 */
export function buildGateConfigLedgerKey(contractId: string): string {
   const contract = new Contract(contractId);
   const ledgerKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
         contract: contract.address().toScAddress(),
         key: xdr.ScVal.scvSymbol(GATE_CONFIG_DATA_KEY),
         durability: xdr.ContractDataDurability.persistent(),
      })
   );
   return ledgerKey.toXDR('base64');
}

/**
 * Decode a base64 LedgerEntry XDR into gate configuration.
 * Returns null when the entry is missing or cannot be decoded.
 */
export function decodeGateConfig(entryXdr: string): GateConfigOnChain | null {
   try {
      const entry = xdr.LedgerEntry.fromXDR(entryXdr, 'base64');
      const data = entry.data();
      if (data.switch() !== xdr.LedgerEntryType.contractData()) {
         return null;
      }
      return readGateConfigFromScVal(data.contractData().val());
   } catch (error) {
      logger.debug(
         { error: (error as Error).message },
         'Failed to decode gate config contract data entry'
      );
      return null;
   }
}

/**
 * Read the gate configuration for a key from the contract.
 * Returns null if not configured or unavailable.
 */
export async function fetchGateConfigFromContract(
   keyId: string
): Promise<GateConfigOnChain | null> {
   const contractId =
      (envConfig as any).GATE_CONFIG_CONTRACT_ID ||
      (envConfig as any).CONTENT_GATE_CONTRACT_ID ||
      (envConfig as any).KEY_GATE_CONTRACT_ID;

   if (!contractId) {
      return null;
   }

   try {
      const response = await getLedgerEntries([
         buildGateConfigLedgerKey(contractId),
      ]);
      const entry = response?.entries?.[0];
      if (!entry?.xdr) {
         return null;
      }
      return decodeGateConfig(entry.xdr);
   } catch (error) {
      logger.warn(
         { keyId, error: (error as Error).message },
         'Gate config contract read failed'
      );
      return null;
   }
}

function readGateConfigFromScVal(scVal: any): GateConfigOnChain | null {
   try {
      const type = scVal.switch();
      if (type === xdr.ScValType.scvMap()) {
         const entries = scVal.map() ?? [];
         let gateType: GateType | null = null;
         let requirementParams: Record<string, unknown> = {};

         for (const mapEntry of entries) {
            const name = readScValKeyName(mapEntry.key());
            const val = mapEntry.val();

            if (!name) continue;

            if (name === 'gate_type' || name === 'gateType' || name === 'type') {
               const t = readScValString(val);
               if (t) {
                  const upper = t.toUpperCase();
                  if (upper === 'HOLDER' || upper === 'SUBSCRIBER' || upper === 'THRESHOLD') {
                     gateType = upper as GateType;
                  } else if (upper === 'NONE' || upper === 'NONE_GATE') {
                     return null;
                  }
               }
            } else if (name === 'requirement_params' || name === 'requirementParams' || name === 'params') {
               requirementParams = readScValMap(val) ?? {};
            } else if (name !== 'is_gated') {
               // Include other fields in params if present
               const v = readScValValue(val);
               if (v !== undefined) {
                  requirementParams[name] = v;
               }
            }
         }

         if (gateType) {
            return { gateType, requirementParams };
         }

         // Check for direct struct fields
         return null;
      }

      // Try to read as struct with different layout
      return null;
   } catch {
      return null;
   }
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

function readScValString(scVal: any): string | null {
   try {
      const type = scVal.switch();
      if (type === xdr.ScValType.scvString()) return scVal.str().toString();
      if (type === xdr.ScValType.scvSymbol()) return scVal.sym().toString();
      return null;
   } catch {
      return null;
   }
}

function readScValMap(scVal: any): Record<string, unknown> | null {
   try {
      if (scVal.switch() !== xdr.ScValType.scvMap()) return null;
      const entries = scVal.map() ?? [];
      const result: Record<string, unknown> = {};
      for (const mapEntry of entries) {
         const name = readScValKeyName(mapEntry.key());
         if (!name) continue;
         const v = readScValValue(mapEntry.val());
         if (v !== undefined) {
            result[name] = v;
         }
      }
      return result;
   } catch {
      return null;
   }
}

function readScValValue(scVal: any): unknown {
   try {
      const type = scVal.switch();
      if (type === xdr.ScValType.scvBool()) return scVal.b();
      if (type === xdr.ScValType.scvU32()) return Number(scVal.u32());
      if (type === xdr.ScValType.scvI32()) return Number(scVal.i32());
      if (type === xdr.ScValType.scvU64()) return scVal.u64().toString();
      if (type === xdr.ScValType.scvI64()) return scVal.i64().toString();
      if (type === xdr.ScValType.scvU128() || type === xdr.ScValType.scvI128()) {
         // best effort
         try {
            return scVal.i128?.toString() || scVal.u128?.toString();
         } catch {
            return undefined;
         }
      }
      if (type === xdr.ScValType.scvString()) return scVal.str().toString();
      if (type === xdr.ScValType.scvSymbol()) return scVal.sym().toString();
      if (type === xdr.ScValType.scvAddress()) {
         try {
            return scVal.address().toString();
         } catch {
            return undefined;
         }
      }
      if (type === xdr.ScValType.scvMap()) {
         const m = readScValMap(scVal);
         return m ?? undefined;
      }
      if (type === xdr.ScValType.scvVec()) {
         const arr: unknown[] = [];
         const vec = scVal.vec() ?? [];
         for (const item of vec) {
            const v = readScValValue(item);
            if (v !== undefined) arr.push(v);
         }
         return arr;
      }
      return undefined;
   } catch {
      return undefined;
   }
}
