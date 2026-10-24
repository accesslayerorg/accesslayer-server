// src/modules/content-access/content-access.service.ts
//
// Content gate access check for a wallet on a key (#1137), used by the
// frontend content section before rendering gated content.
//
// Contract-first: the service simulates the key contract's
// `check_access(wallet, key_id, gate_type)` view and decodes
// `{ is_allowed, gate_type, requirement }` from the result. An injectable
// fetcher (`setContentAccessContractFetcher`) mirrors the whitelist
// module's test seam.
//
// Off-chain fallback: while `check_access` is not yet deployed (contract
// PR in flight), the service evaluates the gate from the views and read
// models that exist today:
//   1. `get_gate_config` (future-proof) → gate_type + requirement,
//   2. else `get_min_hold_for_access` → THRESHOLD gate with the configured
//      minimum,
//   3. else the key is ungated → `{ is_allowed: true, gate_type: 'none' }`.
// THRESHOLD/HOLDER gates are evaluated against `get_key_balance` (on-chain
// view, falling back to the indexed KeyOwnership balance); SUBSCRIBER
// gates against the `is_subscribed` view.
//
// Responses are cached in Redis for 30s, invalidated per key on
// KEY_BOUGHT/KEY_SOLD (balance changes).

import {
   Account,
   Address,
   Contract,
   Networks,
   TransactionBuilder,
   xdr,
} from '@stellar/stellar-base';
import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheSetJson,
   cacheInvalidate,
} from '../../utils/redis.utils';
import { logger } from '../../utils/logger.utils';
import { envConfig } from '../../config';
import {
   CONTENT_ACCESS_CACHE_TTL_SECONDS,
   contentAccessCacheKey,
   contentAccessCachePattern,
} from '../../constants/redis.constants';
import { resolveCreatorId } from '../whitelist/whitelist.service';

/** Gate types returned by the endpoint (issue #1150 vocabulary). */
export type ContentGateType = 'none' | 'HOLDER' | 'SUBSCRIBER' | 'THRESHOLD';

/** Access check result for a wallet on a key. */
export interface ContentAccessResult {
   is_allowed: boolean;
   gate_type: ContentGateType;
   requirement: Record<string, unknown> | null;
}

/**
 * Injectable contract fetcher (test seam / RPC injection), mirroring the
 * whitelist module. Returning null falls through to the next check.
 */
export type ContentAccessContractFetcher = (
   contractId: string,
   wallet: string,
   keyId: string
) => Promise<ContentAccessResult | null>;

let customFetcher: ContentAccessContractFetcher | null = null;

/**
 * Configures an optional custom content-access contract fetcher (for
 * testing or RPC injection).
 */
export function setContentAccessContractFetcher(
   fetcher: ContentAccessContractFetcher | null
): void {
   customFetcher = fetcher;
}

/**
 * Drops every cached content-access response for a key. Called when a
 * balance-changing event (KEY_BOUGHT / KEY_SOLD) is indexed.
 */
export async function invalidateContentAccessCache(
   keyId: string
): Promise<void> {
   await cacheInvalidate(contentAccessCachePattern(keyId));
}

function networkPassphrase(): string {
   return envConfig.STELLAR_NETWORK === 'mainnet'
      ? Networks.PUBLIC
      : Networks.TESTNET;
}

const CONTRACT_ID_REGEX = /^C[A-Z2-7]{55}$/;

/**
 * Resolves a key identifier to its on-chain contract address
 * (RegisteredKey.keyAddress), or null when the key has no contract.
 */
export async function resolveContentAccessContractId(
   keyId: string
): Promise<string | null> {
   if (CONTRACT_ID_REGEX.test(keyId)) {
      return keyId;
   }
   const regKey = await prisma.registeredKey.findFirst({
      where: {
         OR: [{ id: keyId }, { keyAddress: keyId }, { handle: keyId }],
      },
      select: { keyAddress: true },
   });
   return regKey?.keyAddress ?? null;
}

/**
 * Builds an unsigned simulated transaction envelope to query a contract
 * view function with a single Address argument.
 */
export function buildAddressViewXdr(
   contractId: string,
   functionName: string,
   wallet: string,
   sequence = '0'
): string {
   const dummySource = wallet.startsWith('G')
      ? wallet
      : 'GBTEST0000000000000000000000000000000000000000000000000000';
   const operation = new Contract(contractId).call(
      functionName,
      new Address(wallet).toScVal()
   );
   return new TransactionBuilder(new Account(dummySource, sequence), {
      fee: '100',
      networkPassphrase: networkPassphrase(),
   })
      .addOperation(operation)
      .setTimeout(300)
      .build()
      .toXDR();
}

/**
 * Builds an unsigned simulated transaction envelope for
 * `check_access(wallet, key_id)`.
 */
export function buildCheckAccessViewXdr(
   contractId: string,
   wallet: string,
   keyId: string,
   sequence = '0'
): string {
   const dummySource = wallet.startsWith('G')
      ? wallet
      : 'GBTEST0000000000000000000000000000000000000000000000000000';
   const operation = new Contract(contractId).call(
      'check_access',
      new Address(wallet).toScVal(),
      new Address(keyId).toScVal()
   );
   return new TransactionBuilder(new Account(dummySource, sequence), {
      fee: '100',
      networkPassphrase: networkPassphrase(),
   })
      .addOperation(operation)
      .setTimeout(300)
      .build()
      .toXDR();
}

/** Posts a simulateTransaction JSON-RPC call; returns the retval XDR. */
async function simulateView(
   transactionXdr: string,
   rpcId: string
): Promise<string | null> {
   if (!envConfig.STELLAR_SOROBAN_RPC_URL) {
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
            id: rpcId,
            method: 'simulateTransaction',
            params: { transaction: transactionXdr },
         }),
         signal: controller.signal,
      });

      if (!response.ok) {
         return null;
      }

      const envelope = (await response.json()) as {
         error?: { message?: string };
         result?: { results?: Array<{ xdr?: string; retval?: string }> };
      };

      if (envelope.error) {
         return null;
      }

      return (
         envelope.result?.results?.[0]?.retval ??
         envelope.result?.results?.[0]?.xdr ??
         null
      );
   } catch {
      return null;
   } finally {
      clearTimeout(timeout);
   }
}

/** Decodes a ScVal gate_type symbol/string into a ContentGateType. */
function decodeGateTypeScVal(val: xdr.ScVal): ContentGateType | null {
   let raw: string | null = null;
   if (val.switch() === xdr.ScValType.scvSymbol()) {
      raw = val.sym().toString();
   } else if (val.switch() === xdr.ScValType.scvString()) {
      raw = val.str().toString();
   }
   if (!raw) return null;
   const normalized = raw.toUpperCase();
   if (
      normalized === 'HOLDER' ||
      normalized === 'SUBSCRIBER' ||
      normalized === 'THRESHOLD' ||
      normalized === 'NONE'
   ) {
      return normalized as ContentGateType;
   }
   return null;
}

/** Decodes a requirement value (u32 / map) into a plain object. */
function decodeRequirementScVal(
   val: xdr.ScVal
): Record<string, unknown> | null {
   const type = val.switch();
   if (type === xdr.ScValType.scvU32()) {
      return { min_keys: val.u32() };
   }
   if (type === xdr.ScValType.scvU64()) {
      return { min_keys: Number(val.u64().toString()) };
   }
   if (type === xdr.ScValType.scvMap()) {
      const out: Record<string, unknown> = {};
      for (const entry of val.map() ?? []) {
         const keyType = entry.key().switch();
         let keyName = '';
         if (keyType === xdr.ScValType.scvSymbol()) {
            keyName = entry.key().sym().toString();
         } else if (keyType === xdr.ScValType.scvString()) {
            keyName = entry.key().str().toString();
         }
         if (!keyName) continue;
         const valType = entry.val().switch();
         if (valType === xdr.ScValType.scvU32()) {
            out[keyName] = entry.val().u32();
         } else if (valType === xdr.ScValType.scvU64()) {
            out[keyName] = Number(entry.val().u64().toString());
         } else if (valType === xdr.ScValType.scvI128()) {
            out[keyName] = Number(entry.val().i128().toString());
         } else if (valType === xdr.ScValType.scvString()) {
            out[keyName] = entry.val().str().toString();
         } else if (valType === xdr.ScValType.scvSymbol()) {
            out[keyName] = entry.val().sym().toString();
         } else if (valType === xdr.ScValType.scvBool()) {
            out[keyName] = entry.val().b();
         }
      }
      return Object.keys(out).length > 0 ? out : null;
   }
   return null;
}

/**
 * Decodes a check_access return value. Accepts a bool (allowed, ungated
 * semantics), a vec [bool, gate_type, requirement], or a map with
 * is_allowed / gate_type / requirement keys. Returns null when the shape
 * is unrecognised.
 */
export function decodeCheckAccessScVal(
   scValXdr: string
): ContentAccessResult | null {
   try {
      const val = xdr.ScVal.fromXDR(scValXdr, 'base64');
      const type = val.switch();

      if (type === xdr.ScValType.scvBool()) {
         return { is_allowed: val.b(), gate_type: 'none', requirement: null };
      }

      if (type === xdr.ScValType.scvVec()) {
         const vec = val.vec() ?? [];
         if (
            vec.length >= 1 &&
            vec[0].switch() === xdr.ScValType.scvBool()
         ) {
            const isAllowed = vec[0].b();
            const gateType =
               vec.length >= 2 ? decodeGateTypeScVal(vec[1]) : 'none';
            const requirement =
               vec.length >= 3 ? decodeRequirementScVal(vec[2]) : null;
            return {
               is_allowed: isAllowed,
               gate_type: gateType ?? 'none',
               requirement,
            };
         }
      }

      if (type === xdr.ScValType.scvMap()) {
         let isAllowed = true;
         let gateType: ContentGateType = 'none';
         let requirement: Record<string, unknown> | null = null;
         for (const entry of val.map() ?? []) {
            const keyType = entry.key().switch();
            let keyName = '';
            if (keyType === xdr.ScValType.scvSymbol()) {
               keyName = entry.key().sym().toString().toLowerCase();
            } else if (keyType === xdr.ScValType.scvString()) {
               keyName = entry.key().str().toString().toLowerCase();
            }
            if (
               (keyName === 'is_allowed' || keyName === 'allowed') &&
               entry.val().switch() === xdr.ScValType.scvBool()
            ) {
               isAllowed = entry.val().b();
            } else if (keyName === 'gate_type' || keyName === 'gatetype') {
               gateType = decodeGateTypeScVal(entry.val()) ?? 'none';
            } else if (keyName === 'requirement') {
               requirement = decodeRequirementScVal(entry.val());
            }
         }
         return { is_allowed: isAllowed, gate_type: gateType, requirement };
      }

      return null;
   } catch (error) {
      logger.debug(
         { error: (error as Error).message },
         'Failed to decode check_access ScVal'
      );
      return null;
   }
}

/**
 * Calls the key contract's check_access view. Returns null when the
 * function is unavailable, the RPC fails, or the result is undecodable
 * (the fallback then evaluates the gate off-chain).
 */
export async function fetchOnChainContentAccess(
   contractId: string,
   wallet: string,
   keyId: string
): Promise<ContentAccessResult | null> {
   if (customFetcher) {
      const custom = await customFetcher(contractId, wallet, keyId);
      if (custom !== null) return custom;
   }

   try {
      const transactionXdr = buildCheckAccessViewXdr(
         contractId,
         wallet,
         keyId
      );
      const retval = await simulateView(transactionXdr, 'check-access');
      if (!retval) return null;
      return decodeCheckAccessScVal(retval);
   } catch (error) {
      logger.debug(
         { error: (error as Error).message, contractId, wallet },
         'check_access contract call failed; using off-chain fallback'
      );
      return null;
   }
}

/**
 * Reads `get_min_hold_for_access` from the contract. Returns the minimum
 * or null when gating is off / the call is unavailable.
 */
async function fetchMinHoldForAccess(
   contractId: string,
   wallet: string
): Promise<number | null> {
   try {
      const transactionXdr = buildAddressViewXdr(
         contractId,
         'get_min_hold_for_access',
         wallet
      );
      const retval = await simulateView(transactionXdr, 'min-hold');
      if (!retval) return null;

      const val = xdr.ScVal.fromXDR(retval, 'base64');
      if (val.switch() === xdr.ScValType.scvU32()) {
         return val.u32();
      }
      // Option<u32> decodes as a vec: [] = None, [n] = Some(n).
      if (val.switch() === xdr.ScValType.scvVec()) {
         const vec = val.vec() ?? [];
         if (vec.length === 0) return null;
         if (
            vec.length >= 1 &&
            vec[0].switch() === xdr.ScValType.scvU32()
         ) {
            return vec[0].u32();
         }
      }
      return null;
   } catch {
      return null;
   }
}

/**
 * Reads `is_subscribed` from the contract. Returns null when the call is
 * unavailable.
 */
async function fetchIsSubscribed(
   contractId: string,
   wallet: string
): Promise<boolean | null> {
   try {
      const transactionXdr = buildAddressViewXdr(
         contractId,
         'is_subscribed',
         wallet
      );
      const retval = await simulateView(transactionXdr, 'is-subscribed');
      if (!retval) return null;
      const val = xdr.ScVal.fromXDR(retval, 'base64');
      if (val.switch() === xdr.ScValType.scvBool()) {
         return val.b();
      }
      return null;
   } catch {
      return null;
   }
}

/**
 * Reads `get_key_balance` from the contract; falls back to the indexed
 * KeyOwnership balance when the view is unavailable.
 */
async function fetchHolderBalance(
   contractId: string | null,
   wallet: string,
   resolvedKeyId: string
): Promise<number> {
   if (contractId) {
      try {
         const transactionXdr = buildAddressViewXdr(
            contractId,
            'get_key_balance',
            wallet
         );
         const retval = await simulateView(transactionXdr, 'key-balance');
         if (retval) {
            const val = xdr.ScVal.fromXDR(retval, 'base64');
            if (val.switch() === xdr.ScValType.scvI128()) {
               return Number(val.i128().toString());
            }
            if (val.switch() === xdr.ScValType.scvU64()) {
               return Number(val.u64().toString());
            }
            if (val.switch() === xdr.ScValType.scvU32()) {
               return val.u32();
            }
         }
      } catch {
         // Fall through to the indexed balance.
      }
   }

   const ownership = await prisma.keyOwnership.findUnique({
      where: {
         ownerAddress_creatorId: {
            ownerAddress: wallet,
            creatorId: resolvedKeyId,
         },
      },
      select: { balance: true },
   });
   return Number(ownership?.balance ?? 0);
}

/**
 * Detects the configured gate from the off-chain views. Only THRESHOLD
 * gates are detectable today (get_min_hold_for_access); HOLDER/SUBSCRIBER
 * gates are answered by the contract-first check_access path and become
 * detectable here once a gate-config view lands (#1150).
 */
async function detectOffChainGate(
   contractId: string | null,
   wallet: string
): Promise<{
   gateType: ContentGateType;
   requirement: Record<string, unknown> | null;
}> {
   const minHold = contractId
      ? await fetchMinHoldForAccess(contractId, wallet)
      : null;

   if (minHold !== null && minHold > 0) {
      return { gateType: 'THRESHOLD', requirement: { min_keys: minHold } };
   }
   return { gateType: 'none', requirement: null };
}

/**
 * Off-chain gate evaluation used when check_access is unavailable.
 */
async function evaluateOffChain(
   contractId: string | null,
   wallet: string,
   resolvedKeyId: string
): Promise<ContentAccessResult> {
   const { gateType, requirement } = await detectOffChainGate(
      contractId,
      wallet
   );

   if (gateType === 'none') {
      // No configured gate → ungated content.
      return { is_allowed: true, gate_type: 'none', requirement: null };
   }

   if (gateType === 'SUBSCRIBER' && contractId) {
      const subscribed = await fetchIsSubscribed(contractId, wallet);
      if (subscribed !== null) {
         return {
            is_allowed: subscribed,
            gate_type: gateType,
            requirement,
         };
      }
   }

   // THRESHOLD / HOLDER: allowed when the wallet holds at least the
   // configured minimum.
   const minKeys = Number(requirement?.min_keys ?? 0);
   const balance = await fetchHolderBalance(contractId, wallet, resolvedKeyId);
   return {
      is_allowed: balance >= minKeys,
      gate_type: gateType,
      requirement,
   };
}

/**
 * Returns the content-gate access result for a wallet on a key. Cached
 * for 30s per (key, wallet).
 */
export async function getContentAccess(
   keyId: string,
   wallet: string
): Promise<ContentAccessResult> {
   const resolvedKeyId = (await resolveCreatorId(keyId)) ?? keyId;
   const normalizedWallet = wallet.trim();
   const cacheKey = contentAccessCacheKey(resolvedKeyId, normalizedWallet);

   try {
      const cached = await cacheGetJson<ContentAccessResult>(cacheKey);
      if (cached !== null) {
         logger.debug(
            { keyId: resolvedKeyId, wallet: normalizedWallet },
            'Content access cache hit'
         );
         return cached;
      }
   } catch {
      // Cache read failures fall through to evaluation.
   }

   const contractId = await resolveContentAccessContractId(resolvedKeyId);

   let result: ContentAccessResult;
   const onChain = contractId
      ? await fetchOnChainContentAccess(contractId, normalizedWallet, resolvedKeyId)
      : null;

   if (onChain) {
      result = onChain;
   } else {
      result = await evaluateOffChain(
         contractId,
         normalizedWallet,
         resolvedKeyId
      );
   }

   try {
      await cacheSetJson(cacheKey, result, CONTENT_ACCESS_CACHE_TTL_SECONDS);
   } catch {
      // Cache write failures are non-critical.
   }

   return result;
}
