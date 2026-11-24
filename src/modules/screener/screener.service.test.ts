interface MockRow {
   key_id: string;
   handle: string;
   display_name: string;
   price: number;
   change: number;
   volume: number;
   holders: number;
   top10_share: number;
}

const DATASET: MockRow[] = [
   { key_id: 'k1', handle: 'alpha', display_name: 'Alpha', price: 100, change: 10, volume: 5000, holders: 50, top10_share: 30 },
   { key_id: 'k2', handle: 'beta', display_name: 'Beta', price: 250, change: -5, volume: 12000, holders: 120, top10_share: 45 },
   { key_id: 'k3', handle: 'gamma', display_name: 'Gamma', price: 250, change: 25, volume: 8000, holders: 80, top10_share: 60 },
   { key_id: 'k4', handle: 'delta', display_name: 'Delta', price: 500, change: 0, volume: 30000, holders: 200, top10_share: 20 },
   { key_id: 'k5', handle: 'epsilon', display_name: 'Epsilon', price: 1000, change: 50, volume: 1000, holders: 15, top10_share: 85 },
];

const savedScreensStore = new Map<string, any>();

function evaluateWhere(row: MockRow, sql: string, params: unknown[]): boolean {
   const whereMatch = sql.match(/WHERE\s+([\s\S]+?)(?:\s+ORDER BY|\s*$)/i);
   if (!whereMatch) return true;

   const clause = whereMatch[1].trim();
   // Split top-level ANDs (our cursor predicate uses OR inside parens, so handle both)
   const parts = clause.split(/\s+AND\s+(?![^()]*\))/i);

   for (const part of parts) {
      const trimmed = part.trim();
      const betweenMatch = trimmed.match(/^km\.(\w+)\s+BETWEEN\s+\$(\d+)\s+AND\s+\$(\d+)$/i);
      if (betweenMatch) {
         const col = betweenMatch[1] as keyof MockRow;
         const min = Number(params[Number(betweenMatch[2]) - 1]);
         const max = Number(params[Number(betweenMatch[3]) - 1]);
         const val = Number(row[col]);
         if (val < min || val > max) return false;
         continue;
      }

      const cursorMatch = trimmed.match(
         /^\(km\.(\w+)\s*([<>])\s*\$(\d+)\s+OR\s+\(km\.\1\s*=\s*\$\3\s+AND\s+km\.key_id\s*\2\s*\$(\d+)\)\)$/i
      );
      if (cursorMatch) {
         const col = cursorMatch[1] as keyof MockRow;
         const op = cursorMatch[2];
         const sortVal = Number(params[Number(cursorMatch[3]) - 1]);
         const keyId = String(params[Number(cursorMatch[4]) - 1]);
         const rowVal = Number(row[col]);
         const pass =
            op === '>'
               ? rowVal > sortVal || (rowVal === sortVal && row.key_id > keyId)
               : rowVal < sortVal || (rowVal === sortVal && row.key_id < keyId);
         if (!pass) return false;
         continue;
      }

      const cmpMatch = trimmed.match(/^km\.(\w+)\s*(=|<>|>=|<=|>|<)\s*\$(\d+)$/i);
      if (cmpMatch) {
         const col = cmpMatch[1] as keyof MockRow;
         const op = cmpMatch[2];
         const target = Number(params[Number(cmpMatch[3]) - 1]);
         const val = Number(row[col]);
         if (op === '=' && val !== target) return false;
         if (op === '<>' && val === target) return false;
         if (op === '>' && !(val > target)) return false;
         if (op === '>=' && !(val >= target)) return false;
         if (op === '<' && !(val < target)) return false;
         if (op === '<=' && !(val <= target)) return false;
      }
   }

   return true;
}

const queryRawUnsafeMock = jest.fn(async (sql: string, ...params: unknown[]) => {
   const filtered = DATASET.filter(row => evaluateWhere(row, sql, params));
   if (/SELECT\s+COUNT\(\*\)/i.test(sql)) {
      return [{ total: filtered.length }];
   }

   const orderMatch = sql.match(/ORDER BY\s+km\.(\w+)\s+(ASC|DESC),\s+km\.key_id\s+(ASC|DESC)/i);
   const sortCol = (orderMatch?.[1] ?? 'volume') as keyof MockRow;
   const sortDir = (orderMatch?.[2] ?? 'DESC').toUpperCase();

   const sorted = [...filtered].sort((a, b) => {
      const av = Number(a[sortCol]);
      const bv = Number(b[sortCol]);
      if (av !== bv) {
         return sortDir === 'ASC' ? av - bv : bv - av;
      }
      return sortDir === 'ASC'
         ? a.key_id.localeCompare(b.key_id)
         : b.key_id.localeCompare(a.key_id);
   });

   const limitMatch = sql.match(/LIMIT\s+\$(\d+)/i);
   const limit = limitMatch ? Number(params[Number(limitMatch[1]) - 1]) : sorted.length;
   return sorted.slice(0, limit);
});

const prismaMock: any = {
   $queryRawUnsafe: queryRawUnsafeMock,
   $executeRawUnsafe: jest.fn(async () => 0),
   savedScreen: {
      findMany: jest.fn(async ({ where }: any) =>
         Array.from(savedScreensStore.values()).filter(s => s.wallet === where.wallet)
      ),
      count: jest.fn(async ({ where }: any) =>
         Array.from(savedScreensStore.values()).filter(s => s.wallet === where.wallet).length
      ),
      create: jest.fn(async ({ data }: any) => {
         const id = `screen_${savedScreensStore.size + 1}`;
         const row = { id, ...data, createdAt: new Date(), updatedAt: new Date() };
         savedScreensStore.set(id, row);
         return row;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
         const row = savedScreensStore.get(where.id);
         return row && row.wallet === where.wallet ? row : null;
      }),
      delete: jest.fn(async ({ where }: any) => {
         savedScreensStore.delete(where.id);
      }),
   },
};

jest.mock('../../utils/prisma.utils', () => ({ prisma: prismaMock }));
jest.mock('../../config', () => ({
   envConfig: { APP_SECRET: 'test-secret-key-for-screener-tests-0000' },
}));

import {
   ContradictoryRulesError,
   MAX_SAVED_SCREENS_PER_USER,
   validateRuleConsistency,
} from './screener.schemas';
import {
   buildParameterizedWhere,
   SavedScreenLimitError,
   SavedScreenNotFoundError,
   ScreenerService,
} from './screener.service';

describe('ScreenerService (#1312)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      savedScreensStore.clear();
   });

   it('parameterizes all operators without concatenating values into SQL', () => {
      const { clause, params } = buildParameterizedWhere([
         { metric: 'price', operator: 'eq', value: 250 },
         { metric: 'change', operator: 'neq', value: 0 },
         { metric: 'volume', operator: 'gt', value: 1000 },
         { metric: 'holders', operator: 'gte', value: 15 },
         { metric: 'top10_share', operator: 'lt', value: 90 },
         { metric: 'price', operator: 'lte', value: 500 },
         { metric: 'volume', operator: 'between', value: [2000, 30000] },
      ]);

      expect(clause).toBe(
         'WHERE km.price = $1 AND km.change <> $2 AND km.volume > $3 AND km.holders >= $4 AND km.top10_share < $5 AND km.price <= $6 AND km.volume BETWEEN $7 AND $8'
      );
      expect(params).toEqual([250, 0, 1000, 15, 90, 500, 2000, 30000]);
   });

   it.each([
      ['eq', 250, ['k2', 'k3']],
      ['neq', 250, ['k1', 'k4', 'k5']],
      ['gt', 250, ['k4', 'k5']],
      ['gte', 250, ['k2', 'k3', 'k4', 'k5']],
      ['lt', 250, ['k1']],
      ['lte', 250, ['k1', 'k2', 'k3']],
      ['between', [100, 300] as [number, number], ['k1', 'k2', 'k3']],
   ])('returns correct matches for operator %s', async (operator, value, expectedIds) => {
      const res = await ScreenerService.run(
         [{ metric: 'price', operator: operator as any, value }],
         { metric: 'price', direction: 'asc' }
      );
      expect(res.totalCount).toBe(expectedIds.length);
      expect(res.matches.map(m => m.keyId).sort()).toEqual(expectedIds.sort());
   });

   it('provides stable sorting and cursor pagination across pages', async () => {
      const page1 = await ScreenerService.run(
         [],
         { metric: 'price', direction: 'asc' },
         undefined,
         2
      );
      expect(page1.totalCount).toBe(5);
      expect(page1.matches.map(m => m.keyId)).toEqual(['k1', 'k2']);
      expect(page1.cursor).toBeTruthy();

      const page2 = await ScreenerService.run(
         [],
         { metric: 'price', direction: 'asc' },
         page1.cursor!,
         2
      );
      expect(page2.matches.map(m => m.keyId)).toEqual(['k3', 'k4']);
      expect(page2.cursor).toBeTruthy();

      const page3 = await ScreenerService.run(
         [],
         { metric: 'price', direction: 'asc' },
         page2.cursor!,
         2
      );
      expect(page3.matches.map(m => m.keyId)).toEqual(['k5']);
      expect(page3.cursor).toBeNull();
   });

   it('rejects contradictory rules with descriptive errors', () => {
      expect(() =>
         validateRuleConsistency([
            { metric: 'price', operator: 'gt', value: 100 },
            { metric: 'price', operator: 'lt', value: 50 },
         ])
      ).toThrow(ContradictoryRulesError);

      expect(() =>
         validateRuleConsistency([
            { metric: 'holders', operator: 'gte', value: 10 },
            { metric: 'holders', operator: 'lt', value: 10 },
         ])
      ).toThrow(/holders/);

      expect(() =>
         validateRuleConsistency([
            { metric: 'volume', operator: 'eq', value: 500 },
            { metric: 'volume', operator: 'neq', value: 500 },
         ])
      ).toThrow(/eq 500 and neq 500/);

      expect(() =>
         validateRuleConsistency([
            { metric: 'price', operator: 'eq', value: 100 },
            { metric: 'price', operator: 'eq', value: 200 },
         ])
      ).toThrow(/cannot equal both/);

      expect(() =>
         validateRuleConsistency([
            { metric: 'top10_share', operator: 'eq', value: 80 },
            { metric: 'top10_share', operator: 'between', value: [10, 50] },
         ])
      ).toThrow(ContradictoryRulesError);
   });

   it('enforces saved screen limit of 20 per user and supports delete', async () => {
      const wallet = 'GWALLET123';
      for (let i = 0; i < MAX_SAVED_SCREENS_PER_USER; i++) {
         await ScreenerService.createScreen(wallet, {
            name: `Screen ${i + 1}`,
            rules: [{ metric: 'price', operator: 'gt', value: i }],
         });
      }

      await expect(
         ScreenerService.createScreen(wallet, {
            name: 'Screen 21',
            rules: [],
         })
      ).rejects.toThrow(SavedScreenLimitError);

      const list = await ScreenerService.listScreens(wallet);
      expect(list).toHaveLength(MAX_SAVED_SCREENS_PER_USER);

      await ScreenerService.deleteScreen(wallet, list[0].id);
      await expect(
         ScreenerService.deleteScreen('GOTHER', list[1].id)
      ).rejects.toThrow(SavedScreenNotFoundError);
   });
});
