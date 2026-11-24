// src/modules/error-catalog/error-catalog.builder.ts
// Pure catalog construction for contract error codes (#1326). The generator
// script (scripts/build-error-catalog.ts) and the CI drift check both go
// through `buildErrorCatalogFile`, so they always agree on the output.
//
// Versioning: each contract crate keeps an append-only list of versions. A new
// version is appended only when its error set (or wasm hash) changes, so older
// deployments keep resolving to the errors they were built with.

import { createHash } from 'crypto';
import type { ParsedContractError } from './contract-error-parser';

export const ERROR_CATALOG_SCHEMA_VERSION = 1;
export const ERROR_CATALOG_REPOSITORY = 'accesslayerorg/accesslayer-contracts';

export interface ScannedContractError extends ParsedContractError {
   /** Contract crate the error belongs to, e.g. `creator-keys`. */
   crate: string;
}

export interface CatalogError {
   enum: string;
   name: string;
   code: number;
   message: string | null;
   suggestedAction: string;
   actionSource: 'explicit' | 'derived';
}

export interface CatalogVersion {
   version: string;
   wasmHash: string | null;
   sourceCommit: string | null;
   errors: CatalogError[];
}

export interface CatalogContract {
   versions: CatalogVersion[];
}

export interface ErrorCatalogFile {
   schemaVersion: number;
   repository: string;
   contracts: Record<string, CatalogContract>;
}

export interface BuildErrorCatalogInput {
   scanned: ScannedContractError[];
   /** Catalog already on disk; its version history is preserved. */
   existing: ErrorCatalogFile | null;
   sourceCommit: string | null;
   /** Optional wasm hash per crate, when the built artifact is available. */
   wasmHashes?: Record<string, string>;
}

const ACTION_RULES: ReadonlyArray<readonly [RegExp, string]> = [
   [
      /Unauthori[sz]ed|NotAuthori[sz]ed|Auth/i,
      'Sign the request with an account that holds the required authorization, then retry.',
   ],
   [
      /Paused|Suspended|Halted|Frozen|Disabled/i,
      'Wait until the contract or feature is resumed, then retry.',
   ],
   [
      /Insufficient|Balance|Funds/i,
      'Add the missing balance or reduce the amount, then retry.',
   ],
   [
      /NotRegistered|NotFound|NotInitialized|Missing|NoAuction|NoCoCreator|NoSuccessor|NotConfigured|NotSet|NoPosition|PositionNotFound/i,
      'Confirm the referenced entity exists and is set up, then retry.',
   ],
   [
      /AlreadyInitialized|AlreadyConfigured|AlreadyStarted|AlreadyExists|Duplicate|Already/i,
      'Do not repeat this operation; read the current state before retrying.',
   ],
   [
      /Expired|Cooldown|Locked|Timelock|Early|Late|TooRecent|Window|Delay|Pending/i,
      'Wait for the required time window to pass, then retry.',
   ],
   [
      /Overflow|Underflow|Arithmetic/i,
      'Reduce the amount or value so the result stays in range, then retry.',
   ],
   [
      /Invalid|NotPositive|Zero|TooLong|TooLarge|TooMany|OutOfRange|Malformed|Unsupported|Exceeds|Maximum|Minimum|Threshold|Bps/i,
      'Correct the invalid input and retry.',
   ],
];

const DEFAULT_SUGGESTED_ACTION =
   'Review the error and retry after correcting the request or waiting for contract state to change.';

/**
 * Suggested action used when the contract source documents none. Keyed off the
 * variant name, so the first matching rule wins.
 */
export function deriveSuggestedAction(name: string): string {
   for (const [pattern, action] of ACTION_RULES) {
      if (pattern.test(name)) return action;
   }
   return DEFAULT_SUGGESTED_ACTION;
}

/** Stable identifier for an error set: first 16 hex chars of its SHA-256. */
export function digestErrors(errors: CatalogError[]): string {
   return createHash('sha256')
      .update(JSON.stringify(errors))
      .digest('hex')
      .slice(0, 16);
}

/** Stable key used by the undocumented-error baseline. */
export function undocumentedKey(crate: string, error: { enum: string; name: string }): string {
   return `${crate}::${error.enum}::${error.name}`;
}

function compareErrors(a: CatalogError, b: CatalogError): number {
   if (a.enum !== b.enum) return a.enum < b.enum ? -1 : 1;
   if (a.code !== b.code) return a.code - b.code;
   return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function toCatalogError(scanned: ScannedContractError): CatalogError {
   const explicit = scanned.explicitAction;
   return {
      enum: scanned.enum,
      name: scanned.name,
      code: scanned.code,
      message: scanned.message,
      suggestedAction: explicit ?? deriveSuggestedAction(scanned.name),
      actionSource: explicit ? 'explicit' : 'derived',
   };
}

/**
 * Builds the catalog file from scanned contract sources, preserving the
 * version history recorded in `existing`.
 */
export function buildErrorCatalogFile(
   input: BuildErrorCatalogInput
): ErrorCatalogFile {
   const grouped = new Map<string, CatalogError[]>();
   for (const scanned of input.scanned) {
      const list = grouped.get(scanned.crate) ?? [];
      list.push(toCatalogError(scanned));
      grouped.set(scanned.crate, list);
   }

   const contracts: Record<string, CatalogContract> = {};
   for (const [crate, rawErrors] of grouped) {
      const errors = [...rawErrors].sort(compareErrors);
      const digest = digestErrors(errors);
      const wasmHash = input.wasmHashes?.[crate] ?? null;
      const version = wasmHash ?? `src-${digest}`;

      const previous = input.existing?.contracts[crate]?.versions ?? [];
      const latest = previous[previous.length - 1];
      const unchanged =
         latest !== undefined &&
         digestErrors(latest.errors) === digest &&
         (wasmHash === null || latest.wasmHash === wasmHash);

      contracts[crate] = {
         versions: unchanged
            ? previous
            : [
                 ...previous,
                 {
                    version,
                    wasmHash,
                    sourceCommit: input.sourceCommit,
                    errors,
                 },
              ],
      };
   }

   // Crates that disappeared from the sources keep their history so older
   // deployments can still decode their errors.
   for (const [crate, contract] of Object.entries(input.existing?.contracts ?? {})) {
      if (!(crate in contracts)) contracts[crate] = contract;
   }

   const sortedContracts: Record<string, CatalogContract> = {};
   for (const crate of Object.keys(contracts).sort()) {
      sortedContracts[crate] = contracts[crate];
   }

   return {
      schemaVersion: ERROR_CATALOG_SCHEMA_VERSION,
      repository: ERROR_CATALOG_REPOSITORY,
      contracts: sortedContracts,
   };
}

/**
 * Errors in the latest version of each crate that have no doc comment, as
 * `crate::Enum::Variant` keys, sorted.
 */
export function listUndocumentedErrors(file: ErrorCatalogFile): string[] {
   const keys: string[] = [];
   for (const [crate, contract] of Object.entries(file.contracts)) {
      const latest = contract.versions[contract.versions.length - 1];
      if (!latest) continue;
      for (const error of latest.errors) {
         if (error.message === null) keys.push(undocumentedKey(crate, error));
      }
   }
   return [...new Set(keys)].sort();
}
