import { envConfig } from '../config';
import { logger } from '../utils/logger.utils';
import { prisma } from '../utils/prisma.utils';

export const PARTITIONED_TABLES = ['trades', 'ingested_events'] as const;
export type PartitionedTable = (typeof PARTITIONED_TABLES)[number];

type PartitionDeps = {
   queryRawUnsafe: (query: string, ...values: unknown[]) => Promise<unknown>;
   executeRawUnsafe: (query: string, ...values: unknown[]) => Promise<unknown>;
   now: () => Date;
};

export interface PartitionMaintenanceResult {
   table: PartitionedTable;
   created: string[];
   detached: string[];
}

function monthStartUtc(date: Date): Date {
   return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function addMonthsUtc(date: Date, months: number): Date {
   return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function partitionName(table: string, month: Date): string {
   const y = month.getUTCFullYear();
   const m = String(month.getUTCMonth() + 1).padStart(2, '0');
   return `${table}_${y}_${m}`;
}

async function tableIsPartitioned(
   deps: PartitionDeps,
   table: PartitionedTable
): Promise<boolean> {
   const rows = (await deps.queryRawUnsafe(
      `SELECT c.relkind
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema() AND c.relname = $1
       LIMIT 1`,
      table
   )) as Array<{ relkind: string }>;
   return rows[0]?.relkind === 'p';
}

async function partitionExists(
   deps: PartitionDeps,
   table: PartitionedTable,
   child: string
): Promise<boolean> {
   const rows = (await deps.queryRawUnsafe(
      `SELECT 1
       FROM pg_inherits i
       JOIN pg_class parent ON parent.oid = i.inhparent
       JOIN pg_class child ON child.oid = i.inhrelid
       JOIN pg_namespace n ON n.oid = parent.relnamespace
       WHERE n.nspname = current_schema() AND parent.relname = $1 AND child.relname = $2
       LIMIT 1`,
      table,
      child
   )) as Array<Record<string, unknown>>;
   return rows.length > 0;
}

export async function ensureFuturePartitions(
   table: PartitionedTable,
   monthsAhead = envConfig.PARTITION_PRECREATE_MONTHS,
   deps?: Partial<PartitionDeps>
): Promise<string[]> {
   const d = getDeps(deps);
   if (!(await tableIsPartitioned(d, table))) return [];
   const created: string[] = [];
   const start = monthStartUtc(d.now());
   for (let i = 0; i < monthsAhead; i += 1) {
      const from = addMonthsUtc(start, i);
      const to = addMonthsUtc(start, i + 1);
      const name = partitionName(table, from);
      if (await partitionExists(d, table, name)) continue;
      await d.executeRawUnsafe(
         `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "${table}" FOR VALUES FROM ($1) TO ($2)`,
         from.toISOString(),
         to.toISOString()
      );
      created.push(name);
   }
   return created;
}

export async function detachOldPartitions(
   table: PartitionedTable,
   retentionMonths = envConfig.PARTITION_RETENTION_MONTHS,
   deps?: Partial<PartitionDeps>
): Promise<string[]> {
   const d = getDeps(deps);
   if (!(await tableIsPartitioned(d, table))) return [];
   const cutoff = addMonthsUtc(monthStartUtc(d.now()), -retentionMonths);
   const rows = (await d.queryRawUnsafe(
      `SELECT child.relname AS name,
              pg_get_expr(child.relpartbound, child.oid) AS bound
       FROM pg_inherits i
       JOIN pg_class parent ON parent.oid = i.inhparent
       JOIN pg_class child ON child.oid = i.inhrelid
       JOIN pg_namespace n ON n.oid = parent.relnamespace
       WHERE n.nspname = current_schema() AND parent.relname = $1`,
      table
   )) as Array<{ name: string; bound: string }>;

   const detached: string[] = [];
   for (const row of rows) {
      const match = row.bound.match(/TO \('([^']+)'/);
      if (!match) continue;
      const to = new Date(match[1]);
      if (Number.isNaN(to.getTime()) || to > cutoff) continue;
      await d.executeRawUnsafe(
         `ALTER TABLE "${table}" DETACH PARTITION "${row.name}" CONCURRENTLY`
      );
      detached.push(row.name);
   }
   return detached;
}

function getDeps(overrides?: Partial<PartitionDeps>): PartitionDeps {
   return {
      queryRawUnsafe: (query, ...values) =>
         (prisma.$queryRawUnsafe as PartitionDeps['queryRawUnsafe'])(query, ...values),
      executeRawUnsafe: (query, ...values) =>
         (prisma.$executeRawUnsafe as PartitionDeps['executeRawUnsafe'])(query, ...values),
      now: () => new Date(),
      ...overrides,
   };
}

export async function runPartitionMaintenance(
   deps?: Partial<PartitionDeps>
): Promise<PartitionMaintenanceResult[]> {
   const results: PartitionMaintenanceResult[] = [];
   for (const table of PARTITIONED_TABLES) {
      try {
         const created = await ensureFuturePartitions(table, envConfig.PARTITION_PRECREATE_MONTHS, deps);
         const detached = await detachOldPartitions(table, envConfig.PARTITION_RETENTION_MONTHS, deps);
         results.push({ table, created, detached });
         logger.info({ table, created, detached }, 'Partition maintenance completed');
      } catch (error) {
         logger.error({ table, err: error }, 'Partition maintenance failed for table');
         results.push({ table, created: [], detached: [] });
      }
   }
   return results;
}

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startPartitionManagerWorker(): void {
   if (!envConfig.PARTITION_MANAGER_ENABLED) {
      logger.info('Partition manager worker is disabled');
      return;
   }
   if (timer) return;
   const run = async () => {
      if (running) return;
      running = true;
      try {
         await runPartitionMaintenance();
      } catch (error) {
         logger.error({ err: error }, 'Partition maintenance run failed');
      } finally {
         running = false;
      }
   };
   void run();
   timer = setInterval(run, 24 * 60 * 60 * 1000);
   timer.unref?.();
   logger.info('Partition manager worker scheduled daily');
}

export function stopPartitionManagerWorker(): void {
   if (timer) clearInterval(timer);
   timer = null;
}
