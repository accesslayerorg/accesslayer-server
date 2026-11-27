// scripts/build-error-catalog.ts
// Generates error-catalog.json from the contract error enums (#1326).
//
// Usage:
//   pnpm exec ts-node --transpile-only scripts/build-error-catalog.ts \
//     --contracts-dir ../accesslayer-contracts [--wasm-dir <dir>] \
//     [--source-commit <sha>] [--out error-catalog.json] \
//     [--baseline scripts/error-catalog-baseline.json] [--write-baseline]
//
//   ... --check   Fails when the committed catalog is out of date, or when a
//                 contract error without a doc comment is missing from the
//                 undocumented baseline (so new errors must be documented).

import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import {
   existsSync,
   readdirSync,
   readFileSync,
   writeFileSync,
} from 'fs';
import path from 'path';
import {
   crateNameForPath,
   isCatalogSourcePath,
   parseContractErrorEnums,
} from '../src/modules/error-catalog/contract-error-parser';
import {
   buildErrorCatalogFile,
   ErrorCatalogFile,
   listUndocumentedErrors,
   ScannedContractError,
} from '../src/modules/error-catalog/error-catalog.builder';

const REPO_ROOT = path.resolve(__dirname, '..');
const SKIPPED_DIRS = new Set(['target', 'node_modules', '.git', 'tests']);

interface CliOptions {
   contractsDir: string;
   outPath: string;
   baselinePath: string;
   wasmDir: string | null;
   sourceCommit: string | null;
   check: boolean;
   writeBaseline: boolean;
}

function readFlag(args: string[], name: string): string | undefined {
   const index = args.indexOf(name);
   if (index === -1) return undefined;
   const value = args[index + 1];
   if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${name}`);
   }
   return value;
}

function parseOptions(args: string[]): CliOptions {
   const contractsDir = readFlag(args, '--contracts-dir');
   if (!contractsDir) {
      throw new Error('--contracts-dir is required');
   }
   const resolvedContracts = path.resolve(contractsDir);
   const sourceCommit =
      readFlag(args, '--source-commit') ?? detectGitCommit(resolvedContracts);
   const wasmDir = readFlag(args, '--wasm-dir');

   return {
      contractsDir: resolvedContracts,
      outPath: path.resolve(readFlag(args, '--out') ?? path.join(REPO_ROOT, 'error-catalog.json')),
      baselinePath: path.resolve(
         readFlag(args, '--baseline') ??
            path.join(REPO_ROOT, 'scripts', 'error-catalog-baseline.json')
      ),
      wasmDir: wasmDir ? path.resolve(wasmDir) : null,
      sourceCommit,
      check: args.includes('--check'),
      writeBaseline: args.includes('--write-baseline'),
   };
}

function detectGitCommit(dir: string): string | null {
   try {
      return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
         encoding: 'utf8',
      }).trim();
   } catch {
      return null;
   }
}

function collectRustFiles(dir: string, relativeDir: string, out: string[]): void {
   for (const entry of readdirSync(path.join(dir, relativeDir), { withFileTypes: true })) {
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
         if (!SKIPPED_DIRS.has(entry.name)) {
            collectRustFiles(dir, relative, out);
         }
      } else if (entry.isFile() && isCatalogSourcePath(relative)) {
         out.push(relative);
      }
   }
}

function scanContracts(contractsDir: string): ScannedContractError[] {
   const files: string[] = [];
   collectRustFiles(contractsDir, '', files);

   const scanned: ScannedContractError[] = [];
   for (const relative of files.sort()) {
      const source = readFileSync(path.join(contractsDir, relative), 'utf8');
      const crate = crateNameForPath(relative);
      for (const error of parseContractErrorEnums(source)) {
         scanned.push({ ...error, crate });
      }
   }
   return scanned;
}

function hashWasmFiles(wasmDir: string | null, crates: string[]): Record<string, string> {
   const hashes: Record<string, string> = {};
   if (!wasmDir) return hashes;
   for (const crate of crates) {
      // Soroban names wasm artifacts after the crate, with '-' replaced by '_'.
      const candidate = path.join(wasmDir, `${crate.replace(/-/g, '_')}.wasm`);
      if (existsSync(candidate)) {
         hashes[crate] = createHash('sha256')
            .update(readFileSync(candidate))
            .digest('hex');
      }
   }
   return hashes;
}

function readBaseline(baselinePath: string): Set<string> {
   if (!existsSync(baselinePath)) return new Set();
   const parsed = JSON.parse(readFileSync(baselinePath, 'utf8')) as {
      undocumented: string[];
   };
   return new Set(parsed.undocumented);
}

function main(): void {
   const options = parseOptions(process.argv.slice(2));
   const scanned = scanContracts(options.contractsDir);
   if (scanned.length === 0) {
      throw new Error(`No #[contracterror] enums found under ${options.contractsDir}`);
   }

   const existing: ErrorCatalogFile | null = existsSync(options.outPath)
      ? (JSON.parse(readFileSync(options.outPath, 'utf8')) as ErrorCatalogFile)
      : null;
   const crates = [...new Set(scanned.map(error => error.crate))];

   const built = buildErrorCatalogFile({
      scanned,
      existing,
      sourceCommit: options.sourceCommit,
      wasmHashes: hashWasmFiles(options.wasmDir, crates),
   });
   const serialized = `${JSON.stringify(built, null, 2)}\n`;
   const undocumented = listUndocumentedErrors(built);

   if (options.check) {
      const problems: string[] = [];
      const committed = existsSync(options.outPath)
         ? readFileSync(options.outPath, 'utf8')
         : null;
      if (committed !== serialized) {
         problems.push(
            `${options.outPath} is out of date. Regenerate it with scripts/build-error-catalog.ts and commit the result.`
         );
      }
      const baseline = readBaseline(options.baselinePath);
      const novel = undocumented.filter(key => !baseline.has(key));
      if (novel.length > 0) {
         problems.push(
            `Contract errors without a doc comment (message) are not in the baseline: ${novel.join(', ')}`
         );
      }
      if (problems.length > 0) {
         problems.forEach(problem => console.error(`error-catalog: ${problem}`));
         process.exitCode = 1;
         return;
      }
      console.log('error-catalog: catalog is up to date.');
      return;
   }

   writeFileSync(options.outPath, serialized);
   console.log(`Wrote ${options.outPath}`);

   if (options.writeBaseline) {
      writeFileSync(
         options.baselinePath,
         `${JSON.stringify({ undocumented }, null, 2)}\n`
      );
      console.log(`Wrote ${options.baselinePath}`);
   }
}

try {
   main();
} catch (error) {
   console.error(error instanceof Error ? error.message : error);
   process.exitCode = 1;
}
