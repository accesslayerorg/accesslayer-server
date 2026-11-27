// src/modules/error-catalog/contract-error-parser.ts
// Extracts `#[contracterror]` enums from Soroban contract Rust sources (#1326).
//
// The parser is line-based on purpose: contract error enums are flat lists of
// `Variant = <u32>` entries, and the human-facing text lives in `///` doc
// comments directly above each variant. Conventions:
//   - A doc line starting with `Action:` (case-insensitive) is the suggested
//     action for that error. Every other doc line forms the message.
//   - Variants without any doc comment have a null message. The catalog build
//     reports them as undocumented so CI can stop new ones from landing.

export interface ParsedContractError {
   /** Name of the enclosing `#[contracterror]` enum. */
   enum: string;
   /** Variant name, e.g. `NotRegistered`. */
   name: string;
   /** Numeric code the contract returns for this variant. */
   code: number;
   /** Joined doc text, or null when the variant has no doc comment. */
   message: string | null;
   /** Text after an `Action:` doc line, or null when none is documented. */
   explicitAction: string | null;
}

const ACTION_PREFIX = /^action:\s*/i;
const VARIANT_LINE = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)\s*,?\s*(\/\/.*)?$/;
const ENUM_HEADER = /^pub enum (\w+)\s*\{/;

/**
 * Parses every `#[contracterror]` enum in a Rust source file.
 *
 * @param source - Full text of a `.rs` file.
 * @returns One entry per variant, in source order.
 */
export function parseContractErrorEnums(source: string): ParsedContractError[] {
   const lines = source.split(/\r?\n/);
   const errors: ParsedContractError[] = [];

   for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() !== '#[contracterror]') continue;

      // Skip any further attributes (derive, repr) until the enum header.
      let headerIndex = i + 1;
      while (
         headerIndex < lines.length &&
         (lines[headerIndex].trim().startsWith('#[') ||
            lines[headerIndex].trim() === '')
      ) {
         headerIndex++;
      }
      const header = ENUM_HEADER.exec(lines[headerIndex]?.trim() ?? '');
      if (!header) continue;

      const enumName = header[1];
      let docs: string[] = [];
      let k = headerIndex + 1;
      for (; k < lines.length; k++) {
         const line = lines[k].trim();
         if (line === '}') break;
         if (line.startsWith('///')) {
            docs.push(line.slice(3).trim());
            continue;
         }
         if (line === '' || line.startsWith('#[')) continue;

         const variant = VARIANT_LINE.exec(line);
         if (variant) {
            errors.push(toParsedError(enumName, variant[1], Number(variant[2]), docs));
         }
         // Anything else (or a variant) ends the doc block it followed.
         docs = [];
      }
      i = k;
   }

   return errors;
}

function toParsedError(
   enumName: string,
   name: string,
   code: number,
   docLines: string[]
): ParsedContractError {
   const nonEmpty = docLines.filter(line => line.length > 0);
   const actionLine = nonEmpty.find(line => ACTION_PREFIX.test(line));
   const messageLines = nonEmpty.filter(line => line !== actionLine);
   const explicitAction = actionLine
      ? actionLine.replace(ACTION_PREFIX, '').trim() || null
      : null;

   return {
      enum: enumName,
      name,
      code,
      message: messageLines.length > 0 ? messageLines.join(' ') : null,
      explicitAction,
   };
}

/**
 * Returns true for source paths that belong to a contract's runtime code.
 * Build output, VCS metadata, test-only modules and integration tests are
 * excluded so their error enums never reach the public catalog.
 *
 * @param relativePath - POSIX path relative to the contracts repository root.
 */
export function isCatalogSourcePath(relativePath: string): boolean {
   if (!relativePath.endsWith('.rs')) return false;
   const segments = relativePath.split('/');
   const excludedDirs = ['target', 'node_modules', '.git', 'tests'];
   if (segments.some(segment => excludedDirs.includes(segment))) return false;
   const basename = segments[segments.length - 1];
   return !basename.includes('test');
}

/**
 * Crate name for a source path: the first path segment, which is the crate
 * directory in the contracts workspace (e.g. `creator-keys/src/lib.rs`).
 */
export function crateNameForPath(relativePath: string): string {
   return relativePath.split('/')[0];
}
