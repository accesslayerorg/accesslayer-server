import { envConfig } from '../config';
import { logger } from '../utils/logger.utils';
import { prisma } from '../utils/prisma.utils';

const VALID_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type OwnershipSnapshotCleanupResult = {
   skipped: boolean;
   dryRun: boolean;
   cutoffTimestamp: Date;
   affectedRows: number;
   tableName: string;
   reason?: string;
};

type OwnershipSnapshotCleanupDeps = {
   queryRawUnsafe: typeof prisma.$queryRawUnsafe;
   executeRawUnsafe: typeof prisma.$executeRawUnsafe;
   now: () => Date;
};

function getCutoffTimestamp(now: Date, retentionDays: number): Date {
   const cutoffMs = retentionDays * 24 * 60 * 60 * 1000;
   return new Date(now.getTime() - cutoffMs);
}

function assertSafeTableName(tableName: string) {
   if (!VALID_IDENTIFIER.test(tableName)) {
      throw new Error(
         `Invalid OWNERSHIP_SNAPSHOT_TABLE_NAME: ${tableName}. Expected a simple SQL identifier.`
      );
   }
}

async function tableExists(
   queryRawUnsafe: typeof prisma.$queryRawUnsafe,
   tableName: string
): Promise<boolean> {
   const rows = await queryRawUnsafe<Array<{ regclass: string | null }>>(
      'SELECT to_regclass($1) AS regclass',
      `public.${tableName}`
   );

   return Boolean(rows[0]?.regclass);
}

export async function cleanupExpiredOwnershipSnapshots(
   deps?: Partial<OwnershipSnapshotCleanupDeps>
): Promise<OwnershipSnapshotCleanupResult> {
   const queryRawUnsafe = deps?.queryRawUnsafe ?? prisma.$queryRawUnsafe.bind(prisma);
   const executeRawUnsafe =
      deps?.executeRawUnsafe ?? prisma.$executeRawUnsafe.bind(prisma);
   const now = deps?.now ?? (() => new Date());

   const tableName = envConfig.OWNERSHIP_SNAPSHOT_TABLE_NAME;
   const dryRun = envConfig.OWNERSHIP_SNAPSHOT_CLEANUP_DRY_RUN;
   const cutoffTimestamp = getCutoffTimestamp(
      now(),
      envConfig.OWNERSHIP_SNAPSHOT_RETENTION_DAYS
   );

   assertSafeTableName(tableName);

   const exists = await tableExists(queryRawUnsafe, tableName);
   if (!exists) {
      logger.warn(
         {
            tableName,
            cutoffTimestamp: cutoffTimestamp.toISOString(),
            dryRun,
         },
         'Ownership snapshot cleanup skipped because target table was not found'
      );

      return {
         skipped: true,
         reason: 'table_not_found',
         dryRun,
         cutoffTimestamp,
         affectedRows: 0,
         tableName,
      };
   }

   if (dryRun) {
      const rows = await queryRawUnsafe<Array<{ count: number }>>(
         `SELECT COUNT(*)::int AS count FROM "${tableName}" WHERE "expiresAt" < $1`,
         cutoffTimestamp
      );
      const count = rows[0]?.count ?? 0;

      logger.info(
         {
            tableName,
            cutoffTimestamp: cutoffTimestamp.toISOString(),
            retainedDays: envConfig.OWNERSHIP_SNAPSHOT_RETENTION_DAYS,
            wouldDeleteCount: count,
            dryRun,
         },
         'Ownership snapshot cleanup dry-run completed'
      );

      return {
         skipped: false,
         dryRun,
         cutoffTimestamp,
         affectedRows: count,
         tableName,
      };
   }

   const deletedCount = await executeRawUnsafe(
      `DELETE FROM "${tableName}" WHERE "expiresAt" < $1`,
      cutoffTimestamp
   );

   logger.info(
      {
         tableName,
         cutoffTimestamp: cutoffTimestamp.toISOString(),
         retainedDays: envConfig.OWNERSHIP_SNAPSHOT_RETENTION_DAYS,
         deletedCount,
         dryRun,
      },
      'Ownership snapshot cleanup completed'
   );

   return {
      skipped: false,
      dryRun,
      cutoffTimestamp,
      affectedRows: deletedCount,
      tableName,
   };
}

let cleanupTimer: NodeJS.Timeout | null = null;

export function startOwnershipSnapshotCleanupJob() {
   if (!envConfig.OWNERSHIP_SNAPSHOT_CLEANUP_ENABLED) {
      logger.info('Ownership snapshot cleanup job is disabled');
      return;
   }

   const intervalMs =
      envConfig.OWNERSHIP_SNAPSHOT_CLEANUP_INTERVAL_MINUTES * 60 * 1000;

   const run = async () => {
      try {
         await cleanupExpiredOwnershipSnapshots();
      } catch (error) {
         logger.error(
            { err: error },
            'Ownership snapshot cleanup failed with an unexpected error'
         );
      }
   };

   void run();
   cleanupTimer = setInterval(() => {
      void run();
   }, intervalMs);

   if (typeof cleanupTimer.unref === 'function') {
      cleanupTimer.unref();
   }

   logger.info(
      {
         intervalMinutes: envConfig.OWNERSHIP_SNAPSHOT_CLEANUP_INTERVAL_MINUTES,
         retentionDays: envConfig.OWNERSHIP_SNAPSHOT_RETENTION_DAYS,
         dryRun: envConfig.OWNERSHIP_SNAPSHOT_CLEANUP_DRY_RUN,
         tableName: envConfig.OWNERSHIP_SNAPSHOT_TABLE_NAME,
      },
      'Ownership snapshot cleanup job started'
   );
}

export function stopOwnershipSnapshotCleanupJob() {
   if (!cleanupTimer) {
      return;
   }

   clearInterval(cleanupTimer);
   cleanupTimer = null;
   logger.info('Ownership snapshot cleanup job stopped');
}
