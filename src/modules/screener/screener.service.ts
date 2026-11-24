import { prisma } from '../../utils/prisma.utils';
import {
   CursorChecksumError,
   decodeCursor,
   encodeCursor,
} from '../../utils/cursor.utils';
import {
   CreateSavedScreenInput,
   MAX_SAVED_SCREENS_PER_USER,
   SCREENER_DEFAULT_LIMIT,
   ScreenerMetric,
   ScreenerRule,
   ScreenerSort,
   validateRuleConsistency,
} from './screener.schemas';

/**
 * Whitelist mapping from validated metric names to SQL column identifiers
 * on the `key_metrics` materialized view. Never interpolate user strings.
 */
const METRIC_COLUMN_MAP: Record<ScreenerMetric, string> = {
   price: 'km.price',
   change: 'km.change',
   volume: 'km.volume',
   holders: 'km.holders',
   top10_share: 'km.top10_share',
};

export interface KeyMetricRow {
   key_id: string;
   handle: string;
   display_name: string;
   price: string | number;
   change: string | number;
   volume: string | number;
   holders: number;
   top10_share: string | number;
}

export interface ScreenerMatch {
   keyId: string;
   handle: string;
   displayName: string;
   price: number;
   change: number;
   volume: number;
   holders: number;
   top10Share: number;
}

export interface ScreenerRunResult {
   matches: ScreenerMatch[];
   totalCount: number;
   cursor: string | null;
}

interface ScreenerCursorPayload {
   sortValue: number;
   keyId: string;
   sortMetric: ScreenerMetric;
   sortDirection: 'asc' | 'desc';
}

export class SavedScreenLimitError extends Error {
   constructor() {
      super(`Saved screens limit of ${MAX_SAVED_SCREENS_PER_USER} per user reached`);
      this.name = 'SavedScreenLimitError';
   }
}

export class SavedScreenNotFoundError extends Error {
   constructor() {
      super('Saved screen not found');
      this.name = 'SavedScreenNotFoundError';
   }
}

export function buildParameterizedWhere(rules: ScreenerRule[]): {
   clause: string;
   params: unknown[];
} {
   if (rules.length === 0) {
      return { clause: '', params: [] };
   }

   const conditions: string[] = [];
   const params: unknown[] = [];

   for (const rule of rules) {
      const column = METRIC_COLUMN_MAP[rule.metric];
      if (!column) {
         throw new Error(`Unsupported screener metric: ${String(rule.metric)}`);
      }

      switch (rule.operator) {
         case 'eq':
            params.push(rule.value);
            conditions.push(`${column} = $${params.length}`);
            break;
         case 'neq':
            params.push(rule.value);
            conditions.push(`${column} <> $${params.length}`);
            break;
         case 'gt':
            params.push(rule.value);
            conditions.push(`${column} > $${params.length}`);
            break;
         case 'gte':
            params.push(rule.value);
            conditions.push(`${column} >= $${params.length}`);
            break;
         case 'lt':
            params.push(rule.value);
            conditions.push(`${column} < $${params.length}`);
            break;
         case 'lte':
            params.push(rule.value);
            conditions.push(`${column} <= $${params.length}`);
            break;
         case 'between': {
            const [min, max] = rule.value as [number, number];
            params.push(min);
            const minIdx = params.length;
            params.push(max);
            const maxIdx = params.length;
            conditions.push(`${column} BETWEEN $${minIdx} AND $${maxIdx}`);
            break;
         }
         default:
            throw new Error(`Unsupported screener operator: ${String(rule.operator)}`);
      }
   }

   return {
      clause: `WHERE ${conditions.join(' AND ')}`,
      params,
   };
}

function toMatch(row: KeyMetricRow): ScreenerMatch {
   return {
      keyId: row.key_id,
      handle: row.handle,
      displayName: row.display_name,
      price: Number(row.price),
      change: Number(row.change),
      volume: Number(row.volume),
      holders: Number(row.holders),
      top10Share: Number(row.top10_share),
   };
}

export class ScreenerService {
   static async run(
      rules: ScreenerRule[],
      sort: ScreenerSort = { metric: 'volume', direction: 'desc' },
      cursor?: string,
      limit: number = SCREENER_DEFAULT_LIMIT
   ): Promise<ScreenerRunResult> {
      validateRuleConsistency(rules);

      const sortColumn = METRIC_COLUMN_MAP[sort.metric];
      const sortDirSql = sort.direction === 'asc' ? 'ASC' : 'DESC';

      const { clause: baseWhere, params } = buildParameterizedWhere(rules);

      const countSql = `SELECT COUNT(*)::integer AS total FROM key_metrics km ${baseWhere}`;
      const countRows = await prisma.$queryRawUnsafe<Array<{ total: number }>>(
         countSql,
         ...params
      );
      const totalCount = Number(countRows[0]?.total ?? 0);

      const pageParams = [...params];
      let pageWhere = baseWhere;

      if (cursor) {
         const decoded = decodeCursor<ScreenerCursorPayload>(cursor);
         if (
            typeof decoded.sortValue !== 'number' ||
            typeof decoded.keyId !== 'string' ||
            decoded.sortMetric !== sort.metric ||
            decoded.sortDirection !== sort.direction
         ) {
            throw new CursorChecksumError('Cursor does not match current sort');
         }

         pageParams.push(decoded.sortValue);
         const valIdx = pageParams.length;
         pageParams.push(decoded.keyId);
         const idIdx = pageParams.length;

         const cmp = sort.direction === 'asc' ? '>' : '<';
         const cursorPredicate = `(${sortColumn} ${cmp} $${valIdx} OR (${sortColumn} = $${valIdx} AND km.key_id ${cmp} $${idIdx}))`;
         pageWhere = pageWhere
            ? `${pageWhere} AND ${cursorPredicate}`
            : `WHERE ${cursorPredicate}`;
      }

      pageParams.push(limit + 1);
      const limitIdx = pageParams.length;

      const dataSql = `
         SELECT
            km.key_id,
            km.handle,
            km.display_name,
            km.price,
            km.change,
            km.volume,
            km.holders,
            km.top10_share
         FROM key_metrics km
         ${pageWhere}
         ORDER BY ${sortColumn} ${sortDirSql}, km.key_id ${sortDirSql}
         LIMIT $${limitIdx}
      `.trim();

      const rows = await prisma.$queryRawUnsafe<KeyMetricRow[]>(
         dataSql,
         ...pageParams
      );

      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const matches = pageRows.map(toMatch);

      let nextCursor: string | null = null;
      if (hasMore && pageRows.length > 0) {
         const last = pageRows[pageRows.length - 1];
         nextCursor = encodeCursor<ScreenerCursorPayload>({
            sortValue: Number(last[sort.metric]),
            keyId: last.key_id,
            sortMetric: sort.metric,
            sortDirection: sort.direction,
         });
      }

      return { matches, totalCount, cursor: nextCursor };
   }

   static async refreshKeyMetrics(): Promise<void> {
      try {
         await prisma.$executeRawUnsafe(
            'REFRESH MATERIALIZED VIEW CONCURRENTLY key_metrics'
         );
      } catch {
         await prisma.$executeRawUnsafe('REFRESH MATERIALIZED VIEW key_metrics');
      }
   }

   static async listScreens(wallet: string) {
      return prisma.savedScreen.findMany({
         where: { wallet },
         orderBy: { createdAt: 'desc' },
      });
   }

   static async createScreen(wallet: string, input: CreateSavedScreenInput) {
      validateRuleConsistency(input.rules);

      const existingCount = await prisma.savedScreen.count({
         where: { wallet },
      });
      if (existingCount >= MAX_SAVED_SCREENS_PER_USER) {
         throw new SavedScreenLimitError();
      }

      return prisma.savedScreen.create({
         data: {
            wallet,
            name: input.name,
            rules: input.rules as unknown as object,
            ...(input.sort ? { sort: input.sort as unknown as object } : {}),
         },
      });
   }

   static async deleteScreen(wallet: string, id: string): Promise<void> {
      const existing = await prisma.savedScreen.findFirst({
         where: { id, wallet },
         select: { id: true },
      });
      if (!existing) {
         throw new SavedScreenNotFoundError();
      }
      await prisma.savedScreen.delete({ where: { id } });
   }
}
