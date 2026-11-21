import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

type CommandRunner = (
   command: string,
   args: string[],
   options?: { env?: NodeJS.ProcessEnv }
) => Promise<{ stdout: string; stderr: string }>;

const runCommand: CommandRunner = async (command, args, options) =>
   execFile(command, args, { ...options, maxBuffer: 10 * 1024 * 1024 });

const identifierPart = '(?:[A-Za-z_][A-Za-z0-9_]*|"[A-Za-z_][A-Za-z0-9_]*")';
const identifier = new RegExp(`^${identifierPart}(?:\\.${identifierPart})?$`);

function required(name: string): string {
   const value = process.env[name]?.trim();
   if (!value) throw new Error(`${name} is required`);
   return value;
}

function tableName(name: string, fallback: string): string {
   const value = process.env[name]?.trim() || fallback;
   if (!identifier.test(value))
      throw new Error(`${name} must be a SQL identifier`);
   return value;
}

function databaseUrlWithName(
   databaseUrl: string,
   databaseName: string
): string {
   const url = new URL(databaseUrl);
   url.pathname = `/${databaseName}`;
   return url.toString();
}

function safeDatabaseName(): string {
   return `verify_${Date.now()}`;
}

async function latestBackupUri(
   bucketUri: string,
   runner: CommandRunner
): Promise<string> {
   const parsed = new URL(bucketUri);
   if (parsed.protocol !== 's3:') {
      throw new Error('BACKUP_S3_URI must use the s3:// scheme');
   }

   const result = await runner('aws', [
      's3api',
      'list-objects-v2',
      '--bucket',
      parsed.hostname,
      ...(parsed.pathname.length > 1
         ? ['--prefix', parsed.pathname.slice(1)]
         : []),
      '--output',
      'json',
   ]);
   const objects = JSON.parse(result.stdout).Contents ?? [];
   const backup = objects
      .filter(
         (entry: { Key?: unknown; LastModified?: unknown }) =>
            typeof entry.Key === 'string' &&
            typeof entry.LastModified === 'string'
      )
      .sort(
         (left: { LastModified: string }, right: { LastModified: string }) =>
            Date.parse(right.LastModified) - Date.parse(left.LastModified)
      )[0];
   if (!backup) throw new Error('No backup objects found in BACKUP_S3_URI');
   return `s3://${parsed.hostname}/${backup.Key}`;
}

async function queryCount(
   databaseUrl: string,
   table: string,
   runner: CommandRunner
): Promise<number> {
   const result = await runner('psql', [
      databaseUrl,
      '--no-psqlrc',
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT count(*) FROM ${table}`,
   ]);
   const count = Number(result.stdout.trim());
   if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Invalid row count returned for ${table}`);
   }
   return count;
}

async function queryLatestTrade(
   databaseUrl: string,
   table: string,
   runner: CommandRunner
): Promise<Date | null> {
   const result = await runner('psql', [
      databaseUrl,
      '--no-psqlrc',
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT max(executed_at) FROM ${table}`,
   ]);
   const value = result.stdout.trim();
   return value ? new Date(value) : null;
}

async function sendAlert(message: string): Promise<void> {
   const webhook = process.env.ALERT_WEBHOOK_URL?.trim();
   if (!webhook) return;
   const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: message }),
   });
   if (!response.ok)
      throw new Error(`Alert webhook returned HTTP ${response.status}`);
}

export async function verifyBackup(
   runner: CommandRunner = runCommand
): Promise<void> {
   const sourceUrl = required('DATABASE_URL');
   const scratchName = safeDatabaseName();
   const scratchUrl = databaseUrlWithName(sourceUrl, scratchName);
   const maintenanceUrl = databaseUrlWithName(sourceUrl, 'postgres');
   const dumpDirectory = await mkdtemp(`${tmpdir()}/accesslayer-backup-`);
   const dumpPath = `${dumpDirectory}/latest.dump`;
   const tolerance = Number(process.env.BACKUP_ROW_COUNT_TOLERANCE ?? '0');
   const maxAgeHours = Number(process.env.BACKUP_MAX_AGE_HOURS ?? '26');
   const tables = {
      keys: tableName('BACKUP_KEYS_TABLE', '"CreatorProfile"'),
      trades: tableName('BACKUP_TRADES_TABLE', '"Trade"'),
      holders: tableName('BACKUP_HOLDERS_TABLE', '"KeyOwnership"'),
   };
   const failures: string[] = [];

   if (!Number.isInteger(tolerance) || tolerance < 0) {
      throw new Error(
         'BACKUP_ROW_COUNT_TOLERANCE must be a non-negative integer'
      );
   }
   if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
      throw new Error('BACKUP_MAX_AGE_HOURS must be positive');
   }

   try {
      const backupUri = await latestBackupUri(
         required('BACKUP_S3_URI'),
         runner
      );
      await runner('aws', ['s3', 'cp', backupUri, dumpPath]);
      await runner('createdb', [
         '--maintenance-db',
         maintenanceUrl,
         scratchName,
      ]);
      await runner('pg_restore', [
         '--dbname',
         scratchUrl,
         '--no-owner',
         '--exit-on-error',
         dumpPath,
      ]);

      const checks = await Promise.all(
         Object.entries(tables).map(async ([name, table]) => {
            const [sourceCount, restoredCount] = await Promise.all([
               queryCount(sourceUrl, table, runner),
               queryCount(scratchUrl, table, runner),
            ]);
            if (Math.abs(sourceCount - restoredCount) > tolerance) {
               failures.push(`${name}_row_count`);
            }
            return { name, sourceCount, restoredCount };
         })
      );
      const latestTrade = await queryLatestTrade(
         scratchUrl,
         tables.trades,
         runner
      );
      if (
         !latestTrade ||
         Date.now() - latestTrade.getTime() > maxAgeHours * 3600_000
      ) {
         failures.push('latest_trade_age');
      }
      if (failures.length) {
         throw new Error(`Backup verification failed: ${failures.join(', ')}`);
      }
      console.log(`Backup verification passed for ${checks.length} tables`);
   } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      await sendAlert(`AccessLayer backup verification failed: ${detail}`);
      throw error;
   } finally {
      await runner('dropdb', [
         '--if-exists',
         '--maintenance-db',
         maintenanceUrl,
         scratchName,
      ]).catch(() => undefined);
      await rm(dumpDirectory, { recursive: true, force: true });
   }
}

if (require.main === module) {
   verifyBackup().catch(error => {
      // Keep credentials out of logs: only the sanitized error message is emitted.
      console.error(
         error instanceof Error ? error.message : 'Backup verification failed'
      );
      process.exitCode = 1;
   });
}
