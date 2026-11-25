import {
   checkMigrationSql,
   maskSqlCommentsAndStrings,
} from './migration-safety.utils';

const TIMEOUTS = `SET lock_timeout = '5s';
SET statement_timeout = '30s';
`;

function rules(sql: string): string[] {
   return checkMigrationSql(sql).violations.map(v => v.rule);
}

describe('checkMigrationSql', () => {
   it('passes an additive migration with timeouts', () => {
      const sql = `${TIMEOUTS}
ALTER TABLE "IndexerDLQ" ADD COLUMN "replayCount" INTEGER NOT NULL DEFAULT 0;
`;
      expect(checkMigrationSql(sql).violations).toEqual([]);
   });

   it('flags DROP COLUMN', () => {
      const sql = `${TIMEOUTS}ALTER TABLE "Creator" DROP COLUMN "legacy";`;
      expect(rules(sql)).toEqual(['drop-column']);
   });

   it('flags DROP TABLE', () => {
      const sql = `${TIMEOUTS}DROP TABLE "legacy_rows";`;
      expect(rules(sql)).toEqual(['drop-table']);
   });

   it('flags ALTER TYPE and column type changes', () => {
      expect(rules(`${TIMEOUTS}ALTER TYPE "Role" ADD VALUE 'admin';`)).toEqual([
         'alter-type',
      ]);
      expect(
         rules(`${TIMEOUTS}ALTER TABLE "Key" ALTER COLUMN "price" SET DATA TYPE TEXT;`)
      ).toEqual(['alter-type']);
   });

   it('flags RENAME of tables and columns', () => {
      expect(rules(`${TIMEOUTS}ALTER TABLE "Key" RENAME COLUMN "a" TO "b";`)).toEqual([
         'rename',
      ]);
      expect(rules(`${TIMEOUTS}ALTER TABLE "Key" RENAME TO "Key2";`)).toEqual([
         'rename',
      ]);
   });

   it('flags CREATE INDEX on an existing table without CONCURRENTLY', () => {
      const sql = `${TIMEOUTS}CREATE INDEX "Key_price_idx" ON "Key"("price");`;
      expect(rules(sql)).toEqual(['index-not-concurrent']);
   });

   it('allows a lone CREATE INDEX CONCURRENTLY on an existing table', () => {
      const sql = `CREATE INDEX CONCURRENTLY "Key_price_idx" ON "Key"("price");`;
      expect(rules(sql)).toEqual([]);
   });

   it('flags a CONCURRENTLY index that shares a file with other statements', () => {
      const sql = `${TIMEOUTS}CREATE INDEX CONCURRENTLY "Key_price_idx" ON "Key"("price");`;
      expect(rules(sql)).toEqual(['concurrent-index-mixed']);
   });

   it('allows a plain index on a table created in the same migration', () => {
      const sql = `${TIMEOUTS}
CREATE TABLE "Audit" ("id" TEXT NOT NULL, CONSTRAINT "Audit_pkey" PRIMARY KEY ("id"));
CREATE INDEX "Audit_id_idx" ON "Audit"("id");
`;
      expect(rules(sql)).toEqual([]);
   });

   it('requires lock_timeout and statement_timeout', () => {
      expect(rules('ALTER TABLE "A" ADD COLUMN "b" TEXT;')).toEqual([
         'missing-lock-timeout',
         'missing-statement-timeout',
      ]);
   });

   it('ignores a timeout that is only present inside a comment', () => {
      const sql = `-- SET lock_timeout = '5s';
SET statement_timeout = '30s';
ALTER TABLE "A" ADD COLUMN "b" TEXT;`;
      expect(rules(sql)).toEqual(['missing-lock-timeout']);
   });

   it('does not flag risky words that appear only in comments or strings', () => {
      const sql = `${TIMEOUTS}
-- DROP COLUMN is discussed here
COMMENT ON TABLE "A" IS 'do not DROP COLUMN or RENAME TO anything';
`;
      expect(rules(sql)).toEqual([]);
   });

   describe('escape hatch', () => {
      it('waives risky statements when a reason is given', () => {
         const sql = `-- migration-safe: column unused since release 2026.10, verified in prod
${TIMEOUTS}ALTER TABLE "Creator" DROP COLUMN "legacy";`;
         const result = checkMigrationSql(sql);
         expect(result.waived).toBe(true);
         expect(result.waiverReason).toBe(
            'column unused since release 2026.10, verified in prod'
         );
         expect(result.violations).toEqual([]);
      });

      it('rejects an escape hatch with a missing or short reason', () => {
         const sql = `-- migration-safe: ok
${TIMEOUTS}ALTER TABLE "Creator" DROP COLUMN "legacy";`;
         const result = checkMigrationSql(sql);
         expect(result.waived).toBe(false);
         expect(result.violations.map(v => v.rule)).toEqual([
            'invalid-escape-hatch',
            'drop-column',
         ]);
      });

      it('never waives the timeout rules', () => {
         const sql = `-- migration-safe: reviewed by the data team for this change
ALTER TABLE "A" ADD COLUMN "b" TEXT;`;
         expect(rules(sql)).toEqual([
            'missing-lock-timeout',
            'missing-statement-timeout',
         ]);
      });
   });

   it('reports 1-based line numbers for the offending statement', () => {
      const sql = `${TIMEOUTS}
ALTER TABLE "A" ADD COLUMN "b" TEXT;
ALTER TABLE "Creator" DROP COLUMN "legacy";`;
      const [violation] = checkMigrationSql(sql).violations;
      expect(violation.rule).toBe('drop-column');
      expect(violation.line).toBe(5);
   });
});

describe('maskSqlCommentsAndStrings', () => {
   it('keeps the same length and line layout as the input', () => {
      const sql = `SELECT 'a;b' -- trailing
/* block
comment */ FROM t;`;
      const masked = maskSqlCommentsAndStrings(sql);
      expect(masked.length).toBe(sql.length);
      expect(masked.split('\n').length).toBe(sql.split('\n').length);
      expect(masked).not.toContain('trailing');
      expect(masked).not.toContain('block');
   });
});
