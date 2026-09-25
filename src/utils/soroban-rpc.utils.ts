import { logger } from './logger.utils';
import { envConfig } from '../config';

/**
 * Soroban RPC client for querying contract state and ledger entries.
 * Provides methods to read contract storage without signing transactions.
 */

interface GetLedgerEntriesRequest {
   keys: string[]; // Base64-encoded XDR keys
}

interface GetLedgerEntriesResponse {
   entries?: Array<{
      key: string; // Base64-encoded XDR key
      xdr: string; // Base64-encoded XDR ContractDataEntry or other entry
      lastModifiedLedgerSeq: number;
      liveUntilLedgerSeq?: number;
   }>;
   latestLedger: number;
}

interface SorobanRpcError {
   code: number;
   message: string;
}

/**
 * Query contract ledger entries via Soroban RPC.
 * Used to read persistent contract storage without transactions.
 */
export async function getLedgerEntries(
   keys: string[]
): Promise<GetLedgerEntriesResponse | null> {
   if (!envConfig.STELLAR_SOROBAN_RPC_URL || keys.length === 0) {
      return null;
   }

   try {
      const response = await fetch(envConfig.STELLAR_SOROBAN_RPC_URL, {
         method: 'POST',
         headers: {
            'Content-Type': 'application/json',
         },
         body: JSON.stringify({
            jsonrpc: '2.0',
            id: '1',
            method: 'getLedgerEntries',
            params: {
               keys,
            } as GetLedgerEntriesRequest,
         }),
      });

      if (!response.ok) {
         logger.warn(
            {
               status: response.status,
               statusText: response.statusText,
            },
            'Soroban RPC request failed with HTTP error'
         );
         return null;
      }

      const json = await response.json();

      // Check for RPC error response
      if (json.error) {
         const error = json.error as SorobanRpcError;
         logger.warn(
            {
               code: error.code,
               message: error.message,
            },
            'Soroban RPC returned error'
         );
         return null;
      }

      return json.result as GetLedgerEntriesResponse;
   } catch (error) {
      logger.warn({ error }, 'Failed to query Soroban RPC');
      return null;
   }
}

/**
 * Encodes a contract data key for querying persistent storage.
 * Contract data keys are typically built from:
 * - Contract ID (20 bytes)
 * - Ledger key discriminant (4 bytes)
 * - Data key (variable)
 *
 * This is a helper stub; actual encoding depends on contract structure.
 */
export function buildContractDataKey(
   contractId: string,
   discriminant: number,
   dataKey: string
): string {
   // Base64 encoding would happen here after XDR serialization
   // This is a placeholder - actual implementation depends on stellar-sdk
   // For now, return a formatted key that can be used for documentation
   return `${contractId}:${discriminant}:${dataKey}`;
}

/**
 * Decodes a contract data entry from XDR response.
 * Parses the XDR-encoded contract data entry to extract the actual value.
 *
 * Note: This requires stellar-sdk for full XDR parsing.
 * For now, this is a documented placeholder.
 */
export function decodeContractDataEntry(xdr: string): unknown {
   // Would use stellar-sdk to decode:
   // const entry = xdr.ContractDataEntry.fromXDR(xdr, 'base64');
   // return entry;
   logger.debug(
      { xdrLength: xdr.length },
      'Contract data entry decode placeholder'
   );
   return null;
}
