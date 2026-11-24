// src/utils/migration-safety.utils.ts
// Static checks for Prisma migration SQL (#1344). The rules enforce the
// expand / migrate / contract pattern described in docs/migrations.md: a new
// migration must not remove or rename anything that the currently deployed
// app version may still read or write, and must not take long locks without
// a bounded wait.
//
// The checks are intentionally text-based. They do not parse full SQL; they
// strip comments and string literals, split on statement terminators and
// match a small set of forbidden statement shapes.

/** Marker for the per-migration escape hatch: `-- migration-safe: <reason>`. */
export const MIGRATION_SAFE_MARKER = 'migration-safe:';

/** Minimum length for a human-written justification. */
export const MIN_MIGRATION_SAFE_REASON_LENGTH = 10;

export type MigrationRuleId =
   | 'drop-column'
   | 'drop-table'
   | 'alter-type'
   | 'rename'
   | 'index-not-concurrent'
   | 'concurrent-index-mixed'
   | 'missing-lock-timeout'
   | 'missing-statement-timeout'
   | 'invalid-escape-hatch';

export interface MigrationViolation {
   rule: MigrationRuleId;
   /** 1-based line of the offending statement (or of the marker). */
   line: number;
   message: string;
}

export interface MigrationCheckResult {
   violations: MigrationViolation[];
   /** True when a valid `migration-safe` escape hatch waived risky statements. */
   waived: boolean;
   /** The reason text from the escape hatch, when present. */
   waiverReason?: string;
}

interface SqlStatement {
   /** Upper-cased, whitespace-collapsed statement text without comments. */
   text: string;
   /** 1-based line where the statement starts. */
   line: number;
}

/**
 * Replace comments with spaces and blank out string literal contents, keeping
 * every newline and quote in place. The output has the same length and line
 * layout as the input, so offsets map back to source lines.
 */
export function maskSqlCommentsAndStrings(sql: string): string {
   let out = '';
   let i = 0;

   while (i < sql.length) {
      if (sql.startsWith('--', i)) {
         const newline = sql.indexOf('\n', i);
         const stop = newline === -1 ? sql.length : newline;
         out += ' '.repeat(stop - i);
         i = stop;
         continue;
      }

      if (sql.startsWith('/*', i)) {
         const close = sql.indexOf('*/', i + 2);
         const stop = close === -1 ? sql.length : close + 2;
         out += sql.slice(i, stop).replace(/[^\n]/g, ' ');
         i = stop;
         continue;
      }

      if (sql[i] === "'") {
         let j = i + 1;
         while (j < sql.length) {
            if (sql[j] === "'") {
               if (sql[j + 1] === "'") {
                  j += 2;
                  continue;
               }
               break;
            }
            j++;
         }
         const end = Math.min(j, sql.length - 1);
         const inner = sql.slice(i + 1, end).replace(/[^\n]/g, ' ');
         out += `'${inner}'`;
         i = end + 1;
         continue;
      }

      out += sql[i];
      i++;
   }

   return out;
}

/** Split masked SQL into statements, recording each statement's start line. */
function splitStatements(masked: string): SqlStatement[] {
   const statements: SqlStatement[] = [];
   let start = 0;

   const pushFrom = (from: number, to: number) => {
      const raw = masked.slice(from, to);
      const text = raw.replace(/\s+/g, ' ').trim().toUpperCase();
      if (!text) return;
      const leading = raw.length - raw.trimStart().length;
      const offset = from + leading;
      const line = masked.slice(0, offset).split('\n').length;
      statements.push({ text, line });
   };

   for (let i = 0; i < masked.length; i++) {
      if (masked[i] === ';') {
         pushFrom(start, i);
         start = i + 1;
      }
   }
   pushFrom(start, masked.length);

   return statements;
}

/** Extract the table name from `CREATE TABLE` or `... ON <table>` clauses. */
function tableFromStatement(text: string): string | undefined {
   const createTable = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Z0-9_.]+)"?/.exec(
      text
   );
   if (createTable) return createTable[1];

   const onClause = /\sON\s+(?:ONLY\s+)?"?([A-Z0-9_.]+)"?/.exec(text);
   return onClause ? onClause[1] : undefined;
}

/**
 * Check one migration file's SQL against the expand / contract rules.
 *
 * @param sql - Raw migration.sql contents.
 */
export function checkMigrationSql(sql: string): MigrationCheckResult {
   const violations: MigrationViolation[] = [];
   const masked = maskSqlCommentsAndStrings(sql);
   const statements = splitStatements(masked);

   // Escape hatch: a `-- migration-safe: <reason>` line in the raw SQL. The
   // marker must start its own line so the reported line number is exact.
   let waiverReason: string | undefined;
   const markerRegex = new RegExp(
      `^[ \\t]*--[ \\t]*${MIGRATION_SAFE_MARKER}(.*)$`,
      'im'
   );
   const marker = markerRegex.exec(sql);
   if (marker) {
      const markerLine = sql.slice(0, marker.index).split('\n').length;
      const reason = marker[1].trim();
      if (reason.length < MIN_MIGRATION_SAFE_REASON_LENGTH) {
         violations.push({
            rule: 'invalid-escape-hatch',
            line: markerLine,
            message: `${MIGRATION_SAFE_MARKER} needs a reason of at least ${MIN_MIGRATION_SAFE_REASON_LENGTH} characters`,
         });
      } else {
         waiverReason = reason;
      }
   }

   // A valid escape hatch waives the expand/contract statement rules for the
   // whole file. Timeout rules are never waived.
   const waived = waiverReason !== undefined;
   const createdTables = new Set<string>();
   for (const statement of statements) {
      const created = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Z0-9_.]+)"?/.exec(
         statement.text
      );
      if (created) createdTables.add(created[1]);
   }

   // CONCURRENTLY cannot run inside a transaction block, and a multi-statement
   // migration may be sent as one. Such a file must hold only the index
   // statement, so the timeout SET lines are not required for it.
   const concurrentStatements = statements.filter(s => /\bCONCURRENTLY\b/.test(s.text));
   if (concurrentStatements.length > 0) {
      if (statements.length > 1) {
         violations.push({
            rule: 'concurrent-index-mixed',
            line: concurrentStatements[0].line,
            message: 'CONCURRENTLY index statements cannot run in a transaction block; put the index statement alone in its own migration file',
         });
      }
   } else {
      const hasLockTimeout = /\bSET\s+(?:LOCAL\s+)?LOCK_TIMEOUT\s*(?:=|TO)/i.test(masked);
      const hasStatementTimeout = /\bSET\s+(?:LOCAL\s+)?STATEMENT_TIMEOUT\s*(?:=|TO)/i.test(masked);

      if (!hasLockTimeout) {
         violations.push({
            rule: 'missing-lock-timeout',
            line: 1,
            message: 'Add `SET lock_timeout = \'5s\';` so the migration aborts instead of queueing behind locks',
         });
      }
      if (!hasStatementTimeout) {
         violations.push({
            rule: 'missing-statement-timeout',
            line: 1,
            message: 'Add `SET statement_timeout = \'30s\';` so a long statement cannot hold the rollout open',
         });
      }
   }

   for (const statement of statements) {
      const { text, line } = statement;
      const risky: MigrationViolation[] = [];

      if (/\bDROP\s+COLUMN\b/.test(text)) {
         risky.push({
            rule: 'drop-column',
            line,
            message: 'DROP COLUMN breaks instances still running the previous release; drop it in a later contract migration',
         });
      }

      if (/^DROP\s+TABLE\b/.test(text)) {
         risky.push({
            rule: 'drop-table',
            line,
            message: 'DROP TABLE breaks instances still running the previous release; drop it in a later contract migration',
         });
      }

      if (
         /\bALTER\s+TYPE\b/.test(text) ||
         /\bSET\s+DATA\s+TYPE\b/.test(text) ||
         /\bALTER\s+COLUMN\s+\S+\s+TYPE\b/.test(text)
      ) {
         risky.push({
            rule: 'alter-type',
            line,
            message: 'Changing a type rewrites or locks the table and can break the previous release; add a new column instead',
         });
      }

      if (/\bRENAME\s+(?:COLUMN|TO)\b/.test(text)) {
         risky.push({
            rule: 'rename',
            line,
            message: 'RENAME breaks the previous release; add the new name, backfill, and drop the old name in a later migration',
         });
      }

      const isIndexStatement =
         /^CREATE\s+(?:UNIQUE\s+)?INDEX\b/.test(text) || /^DROP\s+INDEX\b/.test(text);
      if (isIndexStatement && !/\bCONCURRENTLY\b/.test(text)) {
         const table = tableFromStatement(text);
         const tableIsNew = table !== undefined && createdTables.has(table);
         if (!tableIsNew) {
            risky.push({
               rule: 'index-not-concurrent',
               line,
               message: 'Index changes on existing tables must use CONCURRENTLY to avoid blocking writes',
            });
         }
      }

      if (!waived) {
         violations.push(...risky);
      }
   }

   violations.sort((a, b) => a.line - b.line);

   return {
      violations,
      waived,
      ...(waiverReason !== undefined ? { waiverReason } : {}),
   };
}
