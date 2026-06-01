import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { prisma } from './prisma.utils';
import { logger } from './logger.utils';

/**
 * Verifies that the local migration files match the checksums recorded in the database.
 * 
 * This helps detect "migration drift" or accidental modifications to historical
 * migration files which could lead to inconsistent environments.
 * 
 * @throws {Error} If a checksum mismatch is detected or if migrations are missing.
 */
export async function verifyMigrationChecksums(): Promise<void> {
   const migrationsPath = path.resolve(process.cwd(), 'prisma', 'schema', 'migrations');

   if (!fs.existsSync(migrationsPath)) {
      logger.warn('Migrations directory not found, skipping checksum verification.');
      return;
   }

   // 1. Check if the migrations table exists
   try {
      await prisma.$queryRawUnsafe(`SELECT 1 FROM "_prisma_migrations" LIMIT 1`);
   } catch (_error) {
      logger.info('Prisma migrations table not found. Skipping verification (fresh database).');
      return;
   }

   // 2. Read local migrations
   const entries = fs.readdirSync(migrationsPath, { withFileTypes: true });
   const migrationDirs = entries
      .filter((entry) => entry.isDirectory() && /^\d+_/.test(entry.name))
      .map((entry) => entry.name)
      .sort();

   if (migrationDirs.length === 0) {
      logger.warn('No migration directories found in prisma/schema/migrations.');
      return;
   }

   // 3. Fetch applied migrations from DB
   const dbMigrations = await prisma.$queryRawUnsafe<any[]>(
      `SELECT migration_name, checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`
   );

   const dbChecksumMap = new Map<string, string>();
   for (const row of dbMigrations) {
      dbChecksumMap.set(row.migration_name, row.checksum);
   }

   // 4. Compare
   for (const migrationName of migrationDirs) {
      const dbChecksum = dbChecksumMap.get(migrationName);
      
      // If the migration hasn't been applied yet, we skip it (it's a new migration)
      if (!dbChecksum) {
         continue;
      }

      const sqlPath = path.join(migrationsPath, migrationName, 'migration.sql');
      if (!fs.existsSync(sqlPath)) {
         throw new Error(`Missing migration file: ${sqlPath}`);
      }

      const sqlContent = fs.readFileSync(sqlPath, 'utf8');
      
      // Prisma normalizes line endings to LF before hashing
      const normalizedContent = sqlContent.replace(/\r\n/g, '\n');
      const localChecksum = crypto
         .createHash('sha256')
         .update(normalizedContent)
         .digest('hex');

      if (localChecksum !== dbChecksum) {
         const errorMsg = `CRITICAL: Migration checksum mismatch for "${migrationName}".
Expected (DB): ${dbChecksum}
Actual (Local): ${localChecksum}

This indicates that the migration file has been modified after it was applied to the database.
To fix this:
1. Revert the changes to the file: ${sqlPath}
2. If the change was intentional, you may need to manually update the checksum in the "_prisma_migrations" table (use with caution).
`;
         logger.error(errorMsg);
         throw new Error(`Migration checksum mismatch for ${migrationName}`);
      }
   }

   logger.info(`Verified checksums for ${dbChecksumMap.size} migrations. All match.`);
}
