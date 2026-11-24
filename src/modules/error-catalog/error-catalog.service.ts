// src/modules/error-catalog/error-catalog.service.ts
// Read side of the contract error catalog (#1326): versioned lookups with
// ETags, and decoding of raw simulation/submission failures.

import { createHash } from 'crypto';
import { existsSync, readFileSync, statSync } from 'fs';
import path from 'path';
import {
   CatalogVersion,
   ERROR_CATALOG_SCHEMA_VERSION,
   ErrorCatalogFile,
} from './error-catalog.builder';

/** `error-catalog.json` at the repository root (same depth in src and dist). */
export const ERROR_CATALOG_PATH = path.resolve(
   __dirname,
   '..',
   '..',
   '..',
   'error-catalog.json'
);

export const UNKNOWN_ERROR_FALLBACK = {
   message:
      'The contract rejected the operation with an error this catalog does not describe.',
   suggestedAction:
      'Retry once. If it keeps failing, contact support with the request id.',
} as const;

export class ErrorCatalogNotFoundError extends Error {
   constructor(message: string) {
      super(message);
      this.name = 'ErrorCatalogNotFoundError';
   }
}

export class ErrorCatalogUnavailableError extends Error {
   constructor(message: string) {
      super(message);
      this.name = 'ErrorCatalogUnavailableError';
   }
}

export interface CatalogViewError {
   code: number;
   enum: string;
   name: string;
   message: string | null;
   suggestedAction: string;
}

export interface ErrorCatalogView {
   contract: string;
   version: string;
   wasmHash: string | null;
   sourceCommit: string | null;
   errorCount: number;
   errors: CatalogViewError[];
}

export interface DecodeErrorInput {
   contract?: string;
   version?: string;
   code?: number;
   raw?: string;
}

export interface DecodedContractError {
   matched: boolean;
   contract: string | null;
   version: string | null;
   code: number | null;
   error: {
      enum: string;
      name: string;
      message: string;
      suggestedAction: string;
      documented: boolean;
   } | null;
   fallback: typeof UNKNOWN_ERROR_FALLBACK | null;
}

// Soroban diagnostics embed contract failures as `Error(Contract, #N)`. The
// later patterns cover clients that pass a plain "contract error N" or
// "code: N" string.
const CODE_PATTERNS: readonly RegExp[] = [
   /Contract,\s*#(\d+)\)/,
   /contract error[^0-9]*(\d+)/i,
   /\bcode\D{0,4}(\d+)/i,
];

let cached: { filePath: string; mtimeMs: number; file: ErrorCatalogFile } | null =
   null;

/** Drops the in-memory catalog so the next read reloads the file. */
export function invalidateErrorCatalogCache(): void {
   cached = null;
}

/**
 * Loads the catalog, reusing the parsed copy until the file's mtime changes.
 * A redeploy that regenerates the file is picked up without a restart.
 */
export function loadErrorCatalog(
   filePath: string = ERROR_CATALOG_PATH
): ErrorCatalogFile {
   if (!existsSync(filePath)) {
      throw new ErrorCatalogUnavailableError('Contract error catalog is not available');
   }
   const { mtimeMs } = statSync(filePath);
   if (cached && cached.filePath === filePath && cached.mtimeMs === mtimeMs) {
      return cached.file;
   }

   const file = JSON.parse(readFileSync(filePath, 'utf8')) as ErrorCatalogFile;
   if (file.schemaVersion !== ERROR_CATALOG_SCHEMA_VERSION) {
      throw new ErrorCatalogUnavailableError(
         `Unsupported error catalog schema version ${file.schemaVersion}`
      );
   }
   cached = { filePath, mtimeMs, file };
   return file;
}

/** Turns `NotRegistered` into `Not registered` for undocumented errors. */
export function humanizeErrorName(name: string): string {
   const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
   return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Resolves a contract's catalog entry. `version` matches either a catalog
 * version id or a wasm hash; omitting it returns the latest version.
 */
export function findCatalogVersion(
   file: ErrorCatalogFile,
   contract: string,
   version?: string
): CatalogVersion {
   if (!Object.prototype.hasOwnProperty.call(file.contracts, contract)) {
      throw new ErrorCatalogNotFoundError(
         `Contract "${contract}" is not in the error catalog`
      );
   }
   const versions = file.contracts[contract].versions;
   const match = version
      ? versions.find(entry => entry.version === version || entry.wasmHash === version)
      : versions[versions.length - 1];
   if (!match) {
      throw new ErrorCatalogNotFoundError(
         `Version "${version}" of contract "${contract}" is not in the error catalog`
      );
   }
   return match;
}

/** Builds the response body and its ETag for one contract version. */
export function getErrorCatalogView(
   input: { contract: string; version?: string },
   file: ErrorCatalogFile = loadErrorCatalog()
): { body: ErrorCatalogView; etag: string } {
   const entry = findCatalogVersion(file, input.contract, input.version);
   const body: ErrorCatalogView = {
      contract: input.contract,
      version: entry.version,
      wasmHash: entry.wasmHash,
      sourceCommit: entry.sourceCommit,
      errorCount: entry.errors.length,
      errors: entry.errors.map(error => ({
         code: error.code,
         enum: error.enum,
         name: error.name,
         message: error.message,
         suggestedAction: error.suggestedAction,
      })),
   };
   const digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
   return { body, etag: `"${digest.slice(0, 32)}"` };
}

/** Extracts a numeric contract error code from a raw failure string. */
export function parseContractErrorCode(raw: string): number | null {
   for (const pattern of CODE_PATTERNS) {
      const match = pattern.exec(raw);
      if (match) return Number(match[1]);
   }
   return null;
}

/**
 * Matches a failure to its catalog entry. Unknown contracts, versions and
 * codes all resolve to the generic fallback rather than an error, so clients
 * can always show something useful.
 */
export function decodeContractError(
   file: ErrorCatalogFile,
   input: DecodeErrorInput
): DecodedContractError {
   const code =
      input.code ?? (input.raw !== undefined ? parseContractErrorCode(input.raw) : null);
   const unmatched: DecodedContractError = {
      matched: false,
      contract: input.contract ?? null,
      version: null,
      code,
      error: null,
      fallback: UNKNOWN_ERROR_FALLBACK,
   };

   if (!input.contract || code === null) return unmatched;

   let entry: CatalogVersion;
   try {
      entry = findCatalogVersion(file, input.contract, input.version);
   } catch (error) {
      if (error instanceof ErrorCatalogNotFoundError) return unmatched;
      throw error;
   }

   const error = entry.errors.find(candidate => candidate.code === code);
   if (!error) return unmatched;

   return {
      matched: true,
      contract: input.contract,
      version: entry.version,
      code,
      error: {
         enum: error.enum,
         name: error.name,
         message: error.message ?? humanizeErrorName(error.name),
         suggestedAction: error.suggestedAction,
         documented: error.message !== null,
      },
      fallback: null,
   };
}
