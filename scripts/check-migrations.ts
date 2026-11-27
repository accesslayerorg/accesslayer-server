// scripts/check-migrations.ts
// CI gate for zero-downtime migration rules (#1344). See docs/migrations.md.
//
// Usage:
//   pnpm exec ts-node --transpile-only scripts/check-migrations.ts --base origin/main
//   pnpm exec ts-node --transpile-only scripts/check-migrations.ts --files path/to/migration.sql
//
// With --base, only migration.sql files added or modified since the merge base
// are checked, so historical migrations are not re-litigated. Exits 1 when any
// violation is found and prints GitHub Actions annotations for each one.

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';
import {
   checkMigrationSql,
   MigrationCheckResult,
} from '../src/utils/migration-safety.utils';

const DEFAULT_MIGRATIONS_DIR = 'prisma/schema/migrations';

interface CliOptions {
   base?: string;
   dir: string;
   files: string[];
}

function parseArgs(argv: string[]): CliOptions {
   const options: CliOptions = { dir: DEFAULT_MIGRATIONS_DIR, files: [] };

   for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      const next = argv[i + 1];
      if (arg === '--base' && next) {
         options.base = next;
         i++;
      } else if (arg === '--dir' && next) {
         options.dir = next;
         i++;
      } else if (arg === '--files' && next) {
         options.files = next.split(',').map(f => f.trim()).filter(Boolean);
         i++;
      } else {
         throw new Error(`Unknown or incomplete argument: ${arg}`);
      }
   }

   if (!options.base && options.files.length === 0) {
      throw new Error('Pass --base <git-ref> or --files <comma-separated paths>');
   }

   return options;
}

/** Migration SQL files added or modified between the merge base and HEAD. */
function changedMigrationFiles(base: string, dir: string): string[] {
   const output = execFileSync(
      'git',
      ['diff', '--name-only', '--diff-filter=AM', `${base}...HEAD`, '--', dir],
      { encoding: 'utf8' }
   );

   return output
      .split('\n')
      .map(line => line.trim())
      .filter(file => /(^|\/)migration\.sql$/.test(file));
}

function report(file: string, result: MigrationCheckResult): number {
   if (result.waived) {
      console.log(
         `::notice file=${file}::Escape hatch used (${result.waiverReason}). Code owner review required.`
      );
   }

   for (const violation of result.violations) {
      console.log(
         `::error file=${file},line=${violation.line},title=${violation.rule}::${violation.message}`
      );
   }

   return result.violations.length;
}

function main(): void {
   const options = parseArgs(process.argv.slice(2));
   const files = options.base
      ? changedMigrationFiles(options.base, options.dir)
      : options.files;

   if (files.length === 0) {
      console.log('No new or changed migration files; nothing to check.');
      return;
   }

   let violationCount = 0;
   for (const file of files) {
      const sql = readFileSync(path.resolve(process.cwd(), file), 'utf8');
      violationCount += report(file, checkMigrationSql(sql));
   }

   if (violationCount > 0) {
      console.error(
         `Migration safety check failed with ${violationCount} violation(s). See docs/migrations.md.`
      );
      process.exit(1);
   }

   console.log(`Checked ${files.length} migration file(s): no violations.`);
}

main();
