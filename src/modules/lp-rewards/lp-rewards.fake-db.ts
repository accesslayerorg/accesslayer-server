// src/modules/lp-rewards/lp-rewards.fake-db.ts
// In-memory stand-in for the subset of the Prisma client used by the key LP
// reward services, so unit tests can drive real multi-epoch state changes
// instead of asserting on mock call shapes. Test-only.

type Row = Record<string, any>;

let idCounter = 0;
const nextId = (prefix: string) => `${prefix}-${String(++idCounter).padStart(6, '0')}`;

function applyData(row: Row, data: Row): void {
   for (const [field, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'increment' in value) {
         row[field] = (BigInt(String(row[field] ?? '0')) + BigInt(String(value.increment))).toString();
      } else {
         row[field] = value;
      }
   }
   row.updatedAt = new Date();
}

function matches(row: Row, where: Row = {}): boolean {
   return Object.entries(where).every(([field, condition]) => {
      if (condition instanceof Date) return row[field]?.getTime() === condition.getTime();
      if (condition && typeof condition === 'object' && ('gte' in condition || 'lt' in condition)) {
         const t = row[field]?.getTime();
         if ('gte' in condition && !(t >= condition.gte.getTime())) return false;
         if ('lt' in condition && !(t < condition.lt.getTime())) return false;
         return true;
      }
      return row[field] === condition;
   });
}

function project(row: Row, select?: Row): Row {
   if (!select) return { ...row };
   return Object.fromEntries(Object.keys(select).map(k => [k, row[k]]));
}

function distinctBy(rows: Row[], fields?: string[]): Row[] {
   if (!fields) return rows;
   const seen = new Set<string>();
   return rows.filter(r => {
      const key = fields.map(f => r[f]).join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
   });
}

export function createFakeLpDb() {
   const state = {
      creators: [] as Row[],
      trades: [] as Row[],
      positions: [] as Row[],
      pools: [] as Row[],
      epochs: [] as Row[],
      accruals: [] as Row[],
      claims: [] as Row[],
   };

   const db: Record<string, any> & { state: typeof state; reset: () => void } = {
      state,
      reset() {
         Object.values(state).forEach(rows => rows.splice(0));
      },
      creatorProfile: {
         findUnique: async ({ where }: Row) => state.creators.find(c => c.id === where.id) ?? null,
      },
      trade: {
         findMany: async ({ where, select, distinct }: Row) =>
            distinctBy(state.trades.filter(t => matches(t, where)), distinct).map(t => project(t, select)),
      },
      keyLpPosition: {
         findUnique: async ({ where }: Row) =>
            state.positions.find(
               p => p.keyId === where.keyId_wallet.keyId && p.wallet === where.keyId_wallet.wallet
            ) ?? null,
         findMany: async ({ where, select, distinct, orderBy }: Row = {}) => {
            let rows = state.positions.filter(p => matches(p, where));
            if (orderBy?.id === 'asc') rows = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
            return distinctBy(rows, distinct).map(p => project(p, select));
         },
         create: async ({ data }: Row) => {
            if (state.positions.some(p => p.keyId === data.keyId && p.wallet === data.wallet)) {
               throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
            }
            const row: Row = {
               id: nextId('pos'),
               lpTokens: '0',
               entryPrice: '0',
               eligibleLpTokens: '0',
               accruedRewards: '0',
               claimedRewards: '0',
               lastDepositAt: null,
               lastAccruedEpochEnd: null,
               createdAt: new Date(),
               updatedAt: new Date(),
            };
            applyData(row, data);
            state.positions.push(row);
            return { ...row };
         },
         update: async ({ where, data }: Row) => {
            const row = state.positions.find(p => p.id === where.id);
            if (!row) throw Object.assign(new Error('Not found'), { code: 'P2025' });
            applyData(row, data);
            return { ...row };
         },
         updateMany: async ({ where, data }: Row) => {
            const rows = state.positions.filter(p => matches(p, where));
            rows.forEach(r => applyData(r, data));
            return { count: rows.length };
         },
         aggregate: async ({ where }: Row) => {
            const rows = state.positions.filter(p => matches(p, where));
            if (rows.length === 0) return { _sum: { lpTokens: null } };
            const scaled = rows.reduce((sum, r) => {
               const [whole, frac = ''] = String(r.lpTokens).split('.');
               return sum + BigInt(whole) * 10n ** 7n + BigInt(frac.padEnd(7, '0').slice(0, 7) || '0');
            }, 0n);
            const digits = scaled.toString().padStart(8, '0');
            return { _sum: { lpTokens: `${digits.slice(0, -7)}.${digits.slice(-7)}` } };
         },
      },
      keyLpRewardPool: {
         findUnique: async ({ where }: Row) => {
            const row = state.pools.find(p => p.keyId === where.keyId);
            return row ? { ...row } : null;
         },
         findMany: async ({ select }: Row = {}) => state.pools.map(p => project(p, select)),
         upsert: async ({ where, create }: Row) => {
            const existing = state.pools.find(p => p.keyId === where.keyId);
            if (existing) return { ...existing };
            const created: Row = { balance: '0', totalFunded: '0', totalDistributed: '0', ...create };
            state.pools.push(created);
            return { ...created };
         },
         updateMany: async ({ where, data }: Row) => {
            const rows = state.pools.filter(p => matches(p, where));
            rows.forEach(r => applyData(r, data));
            return { count: rows.length };
         },
      },
      keyLpRewardEpoch: {
         create: async ({ data }: Row) => {
            if (
               state.epochs.some(
                  e => e.keyId === data.keyId && e.epochStart.getTime() === data.epochStart.getTime()
               )
            ) {
               throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
            }
            const row = { id: nextId('epoch'), createdAt: new Date(), ...data };
            state.epochs.push(row);
            return { ...row };
         },
      },
      keyLpRewardAccrual: {
         createMany: async ({ data }: Row) => {
            data.forEach((d: Row) => state.accruals.push({ id: nextId('accrual'), ...d }));
            return { count: data.length };
         },
      },
      keyLpRewardClaim: {
         create: async ({ data }: Row) => {
            const row = { id: nextId('claim'), status: 'pending', createdAt: new Date(), ...data };
            state.claims.push(row);
            return { ...row };
         },
      },
      // No rollback: services under test throw before writing on the
      // guarded paths exercised here.
      $transaction: async (fn: (tx: any) => Promise<unknown>) => fn(db),
   };

   return db;
}

export type FakeLpDb = ReturnType<typeof createFakeLpDb>;
