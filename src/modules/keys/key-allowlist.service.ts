// src/modules/keys/key-allowlist.service.ts
//
// Bulk CSV import for early-access key allowlists (#1246).
//
// The importer parses a CSV with an `address` column and an optional `cap`
// column, validates every row (Stellar StrKey address, positive integer cap,
// no duplicate addresses inside the file), then applies the valid rows in a
// single transaction. Invalid rows never abort the import: they are reported
// with their CSV row number while valid rows are still applied.
//
// A dry run performs the exact same parsing/validation/counting but issues no
// writes.

import { parse } from 'csv-parse/sync';
import { StrKey } from '@stellar/stellar-base';
import { prisma } from '../../utils/prisma.utils';

/** Maximum accepted CSV upload size (2 MB). */
export const MAX_ALLOWLIST_FILE_BYTES = 2 * 1024 * 1024;

/** Maximum accepted number of data rows in one CSV file. */
export const MAX_ALLOWLIST_ROWS = 5000;

/** Thrown when the uploaded CSV exceeds {@link MAX_ALLOWLIST_FILE_BYTES}. */
export class AllowlistFileTooLargeError extends Error {
   constructor() {
      super('CSV file exceeds the 2 MB limit');
      this.name = 'AllowlistFileTooLargeError';
   }
}

/** Thrown when the CSV contains more than {@link MAX_ALLOWLIST_ROWS} rows. */
export class AllowlistRowLimitExceededError extends Error {
   constructor() {
      super(`CSV file exceeds the ${MAX_ALLOWLIST_ROWS} row limit`);
      this.name = 'AllowlistRowLimitExceededError';
   }
}

/** Thrown when the CSV cannot be parsed or lacks an `address` column. */
export class AllowlistCsvParseError extends Error {
   constructor(message: string) {
      super(message);
      this.name = 'AllowlistCsvParseError';
   }
}

export interface AllowlistRowError {
   /** 1-based line number in the uploaded CSV (the header is row 1). */
   row: number;
   message: string;
}

export interface AllowlistImportReport {
   dryRun: boolean;
   /** Number of data rows read from the file. */
   totalRows: number;
   /** Rows that created a new allowlist entry. */
   created: number;
   /** Rows that updated an existing allowlist entry. */
   updated: number;
   /** Rows rejected during validation (invalid address, cap or duplicate). */
   skipped: number;
   errors: AllowlistRowError[];
}

export interface ParsedAllowlistRow {
   row: number;
   address: string;
   cap: number | null;
}

export interface ParseAllowlistResult {
   rows: ParsedAllowlistRow[];
   errors: AllowlistRowError[];
   totalRows: number;
}

const CSV_PARSE_OPTIONS = {
   bom: true,
   trim: true,
   skip_empty_lines: true,
   relax_column_count: true,
} as const;

/**
 * Normalizes CSV header names so `Address`/`ADDRESS` are treated the same as
 * `address`. Kept separate from parsing so the header check and the record
 * parse agree on column names.
 */
function normalizeHeader(header: string[]): string[] {
   return header.map(name => name.trim().toLowerCase());
}

function readHeaderRow(csv: Buffer | string): string[] {
   try {
      const parsed = parse(csv, {
         bom: true,
         trim: true,
         to_line: 1,
      }) as string[][];
      return normalizeHeader(parsed[0] ?? []);
   } catch {
      throw new AllowlistCsvParseError('CSV file could not be parsed');
   }
}

/**
 * Parses and validates an allowlist CSV without touching the database.
 *
 * Row numbers refer to the physical CSV line, so the first data row is 2.
 * Duplicate addresses are reported on every occurrence after the first one;
 * only the first occurrence is kept.
 */
export function parseAllowlistCsv(csv: Buffer | string): ParseAllowlistResult {
   const header = readHeaderRow(csv);
   if (!header.includes('address')) {
      throw new AllowlistCsvParseError('CSV must include an "address" column');
   }

   let records: Array<{
      record: Record<string, string>;
      info: { lines: number };
   }>;
   try {
      records = parse(csv, {
         ...CSV_PARSE_OPTIONS,
         columns: normalizeHeader,
         info: true,
      }) as Array<{
         record: Record<string, string>;
         info: { lines: number };
      }>;
   } catch {
      throw new AllowlistCsvParseError('CSV file could not be parsed');
   }

   if (records.length > MAX_ALLOWLIST_ROWS) {
      throw new AllowlistRowLimitExceededError();
   }

   const rows: ParsedAllowlistRow[] = [];
   const errors: AllowlistRowError[] = [];
   const firstSeenAt = new Map<string, number>();

   for (const { record, info } of records) {
      const row = info.lines;
      const rawAddress =
         typeof record.address === 'string' ? record.address.trim() : '';

      if (!rawAddress) {
         errors.push({ row, message: 'address is required' });
         continue;
      }

      if (!StrKey.isValidEd25519PublicKey(rawAddress)) {
         errors.push({
            row,
            message: `invalid Stellar address: ${rawAddress}`,
         });
         continue;
      }

      const rawCap =
         record.cap === undefined || record.cap === null
            ? ''
            : String(record.cap).trim();
      let cap: number | null = null;
      if (rawCap !== '') {
         if (!/^\d+$/.test(rawCap)) {
            errors.push({
               row,
               message: 'cap must be a positive integer',
            });
            continue;
         }
         cap = Number(rawCap);
         if (!Number.isSafeInteger(cap) || cap <= 0) {
            errors.push({
               row,
               message: 'cap must be a positive integer',
            });
            continue;
         }
      }

      const duplicateRow = firstSeenAt.get(rawAddress);
      if (duplicateRow !== undefined) {
         errors.push({
            row,
            message: `duplicate address ${rawAddress} (first seen at row ${duplicateRow})`,
         });
         continue;
      }

      firstSeenAt.set(rawAddress, row);
      rows.push({ row, address: rawAddress, cap });
   }

   errors.sort((a, b) => a.row - b.row);

   return { rows, errors, totalRows: records.length };
}

/**
 * Imports an allowlist CSV for a creator key.
 *
 * Valid rows are upserted in a single `$transaction`, so any database failure
 * rolls the whole import back. When `dryRun` is true nothing is written.
 *
 * `creatorId` must already be resolved to a `CreatorProfile.id`.
 */
export async function importAllowlistCsv(
   creatorId: string,
   csv: Buffer | string,
   options: { dryRun?: boolean } = {}
): Promise<AllowlistImportReport> {
   const dryRun = options.dryRun === true;
   const size = Buffer.isBuffer(csv) ? csv.byteLength : Buffer.byteLength(csv);

   if (size > MAX_ALLOWLIST_FILE_BYTES) {
      throw new AllowlistFileTooLargeError();
   }

   const { rows, errors, totalRows } = parseAllowlistCsv(csv);

   let created = 0;
   let updated = 0;

   if (rows.length > 0) {
      const addresses = rows.map(row => row.address);
      const existing = await prisma.keyAllowlistEntry.findMany({
         where: { creatorId, address: { in: addresses } },
         select: { address: true },
      });
      const existingAddresses = new Set(existing.map(entry => entry.address));
      created = rows.filter(row => !existingAddresses.has(row.address)).length;
      updated = rows.length - created;

      if (!dryRun) {
         await prisma.$transaction(
            rows.map(row =>
               prisma.keyAllowlistEntry.upsert({
                  where: {
                     creatorId_address: {
                        creatorId,
                        address: row.address,
                     },
                  },
                  create: {
                     creatorId,
                     address: row.address,
                     cap: row.cap,
                  },
                  update: { cap: row.cap },
               })
            )
         );
      }
   }

   return {
      dryRun,
      totalRows,
      created,
      updated,
      skipped: errors.length,
      errors,
   };
}
