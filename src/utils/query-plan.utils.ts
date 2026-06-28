import { prisma } from './prisma.utils';
import { logger } from './logger.utils';
import { envConfig } from '../config';

/**
 * A single node in a PostgreSQL EXPLAIN JSON plan tree.
 * Typed loosely so we can log it without exhaustively modelling every field.
 */
export type QueryPlanNode = Record<string, unknown>;

/**
 * Runs `EXPLAIN (FORMAT JSON)` for the given raw SQL and returns the parsed
 * plan array, or `null` when the capture fails or is not applicable.
 *
 * This function is intentionally a no-op outside of development mode so it
 * can never add overhead to production queries.
 *
 * @param sql  - The SQL statement to explain (no parameter substitution needed
 *               for EXPLAIN; the planner only needs the query shape).
 * @param params - Bound parameters for the statement (passed through to
 *                 `$queryRawUnsafe` so the planner sees the real types).
 * @returns The plan nodes, or `null` on error / non-debug environment.
 */
export async function captureQueryPlan(
   sql: string,
   params: unknown[] = []
): Promise<QueryPlanNode[] | null> {
   if (envConfig.MODE !== 'development') {
      return null;
   }

   try {
      // EXPLAIN does not execute the query, so it is safe to run inline.
      const explainSql = `EXPLAIN (FORMAT JSON) ${sql}`;
      const rows = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': QueryPlanNode[] }>>(
         explainSql,
         ...params
      );
      return rows[0]?.['QUERY PLAN'] ?? null;
   } catch (err) {
      // Never let plan capture crash the request path.
      logger.debug(
         { err, msg: 'Failed to capture query plan for slow query' },
         'query-plan capture error'
      );
      return null;
   }
}
