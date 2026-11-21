// Service-level tests for key reports (#1226), backed by a small in-memory
// Prisma fake so duplicate protection, keyset pagination and status
// transitions are exercised against real data semantics.

type Row = {
   id: string;
   keyId: string;
   reporter: string;
   reason: string;
   details: string | null;
   status: string;
   createdAt: Date;
   updatedAt: Date;
};

const db: { keys: Set<string>; reports: Row[]; seq: number } = {
   keys: new Set(),
   reports: [],
   seq: 0,
};

function matches(row: Row, where: any): boolean {
   if (!where) return true;
   for (const [field, cond] of Object.entries(where)) {
      if (field === 'OR') {
         if (!(cond as any[]).some(c => matches(row, c))) return false;
         continue;
      }
      const value = (row as any)[field];
      if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
         if ('lt' in (cond as any)) {
            const lt = (cond as any).lt;
            if (!(value < lt)) return false;
         }
         continue;
      }
      if (cond instanceof Date) {
         if (value.getTime() !== cond.getTime()) return false;
         continue;
      }
      if (value !== cond) return false;
   }
   return true;
}

const keyReport = {
   findFirst: jest.fn(
      async ({ where }: any) => db.reports.find(r => matches(r, where)) ?? null
   ),
   findUnique: jest.fn(
      async ({ where }: any) => db.reports.find(r => r.id === where.id) ?? null
   ),
   findMany: jest.fn(async ({ where, take }: any) =>
      db.reports
         .filter(r => matches(r, where))
         .sort(
            (a, b) =>
               b.createdAt.getTime() - a.createdAt.getTime() ||
               (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
         )
         .slice(0, take)
   ),
   create: jest.fn(async ({ data }: any) => {
      if (!db.keys.has(data.keyId)) {
         throw Object.assign(new Error('FK violation'), { code: 'P2003' });
      }
      const now = new Date();
      const row: Row = {
         id: `report-${++db.seq}`,
         status: 'open',
         createdAt: now,
         updatedAt: now,
         ...data,
      };
      db.reports.push(row);
      return row;
   }),
   updateMany: jest.fn(async ({ where, data }: any) => {
      const rows = db.reports.filter(r => matches(r, where));
      rows.forEach(r => Object.assign(r, data, { updatedAt: new Date() }));
      return { count: rows.length };
   }),
};

const mockPrisma: any = {
   creatorProfile: {
      findUnique: jest.fn(async ({ where }: any) =>
         db.keys.has(where.id) ? { id: where.id } : null
      ),
   },
   keyReport,
   $executeRaw: jest.fn(async () => 1),
   $transaction: jest.fn(async (cb: any) => cb(mockPrisma)),
};

jest.mock('../../utils/prisma.utils', () => ({ prisma: mockPrisma }));

import {
   createKeyReport,
   DuplicateOpenKeyReportError,
   InvalidKeyReportCursorError,
   InvalidKeyReportTransitionError,
   KeyReportKeyNotFoundError,
   KeyReportNotFoundError,
   listKeyReports,
   updateKeyReportStatus,
} from './key-reports.service';
import {
   isValidKeyReportTransition,
   KEY_REPORT_STATUSES,
   KeyReportStatusValue,
} from './key-reports.schemas';
import { encodeCursor } from '../../utils/cursor.utils';

const REPORTER = `G${'R'.repeat(55)}`;
const OTHER = `G${'S'.repeat(55)}`;

function seedReport(overrides: Partial<Row> = {}): Row {
   const createdAt = overrides.createdAt ?? new Date();
   const row: Row = {
      id: `seed-${++db.seq}`,
      keyId: 'key-1',
      reporter: REPORTER,
      reason: 'scam',
      details: null,
      status: 'open',
      createdAt,
      updatedAt: createdAt,
      ...overrides,
   };
   db.reports.push(row);
   return row;
}

beforeEach(() => {
   jest.clearAllMocks();
   db.keys = new Set(['key-1', 'key-2']);
   db.reports = [];
   db.seq = 0;
});

describe('createKeyReport', () => {
   it('stores a valid report with status open', async () => {
      const report = await createKeyReport('key-1', REPORTER, {
         reason: 'impersonation',
         details: 'pretending to be someone else',
      });

      expect(report).toMatchObject({
         keyId: 'key-1',
         reporter: REPORTER,
         reason: 'impersonation',
         details: 'pretending to be someone else',
         status: 'open',
      });
      expect(typeof report.createdAt).toBe('string');
      expect(db.reports).toHaveLength(1);
   });

   it('stores null details when omitted', async () => {
      const report = await createKeyReport('key-1', REPORTER, {
         reason: 'other',
      });
      expect(report.details).toBeNull();
   });

   it('takes the (key, reporter) advisory lock inside the transaction before checking', async () => {
      await createKeyReport('key-1', REPORTER, { reason: 'scam' });

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.$executeRaw).toHaveBeenCalledTimes(1);
      const [sqlParts, ...values] = mockPrisma.$executeRaw.mock.calls[0];
      expect(sqlParts.join('?')).toContain('pg_advisory_xact_lock');
      expect(values).toEqual(['key-1', REPORTER]);
      expect(mockPrisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
         keyReport.findFirst.mock.invocationCallOrder[0]
      );
   });

   it('rejects a duplicate open report from the same wallet for the same key', async () => {
      await createKeyReport('key-1', REPORTER, { reason: 'scam' });
      await expect(
         createKeyReport('key-1', REPORTER, { reason: 'harassment' })
      ).rejects.toBeInstanceOf(DuplicateOpenKeyReportError);
      expect(db.reports).toHaveLength(1);
   });

   it('allows the same wallet to report a different key', async () => {
      await createKeyReport('key-1', REPORTER, { reason: 'scam' });
      await expect(
         createKeyReport('key-2', REPORTER, { reason: 'scam' })
      ).resolves.toMatchObject({ keyId: 'key-2' });
   });

   it('allows a different wallet to report the same key', async () => {
      await createKeyReport('key-1', REPORTER, { reason: 'scam' });
      await expect(
         createKeyReport('key-1', OTHER, { reason: 'scam' })
      ).resolves.toMatchObject({ reporter: OTHER });
   });

   it.each(['reviewing', 'dismissed', 'actioned'])(
      'allows a new report once the previous one is %s',
      async status => {
         seedReport({ status });
         await expect(
            createKeyReport('key-1', REPORTER, { reason: 'scam' })
         ).resolves.toMatchObject({ status: 'open' });
      }
   );

   it('throws KeyReportKeyNotFoundError for a nonexistent key', async () => {
      await expect(
         createKeyReport('missing', REPORTER, { reason: 'scam' })
      ).rejects.toBeInstanceOf(KeyReportKeyNotFoundError);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
   });

   it('maps a foreign key violation (key deleted mid-request) to not found', async () => {
      mockPrisma.creatorProfile.findUnique.mockResolvedValueOnce({
         id: 'gone',
      });
      await expect(
         createKeyReport('gone', REPORTER, { reason: 'scam' })
      ).rejects.toBeInstanceOf(KeyReportKeyNotFoundError);
   });

   it('propagates unexpected database errors', async () => {
      keyReport.create.mockRejectedValueOnce(new Error('connection lost'));
      await expect(
         createKeyReport('key-1', REPORTER, { reason: 'scam' })
      ).rejects.toThrow('connection lost');
   });
});

describe('listKeyReports', () => {
   function seedMany(count: number, startMs = Date.UTC(2026, 10, 20)) {
      for (let i = 0; i < count; i++) {
         seedReport({
            keyId: `key-${i}`,
            createdAt: new Date(startMs + i * 1000),
            status: i % 2 === 0 ? 'open' : 'reviewing',
         });
      }
   }

   it('returns newest first with no cursor when everything fits', async () => {
      seedMany(3);
      const page = await listKeyReports({ limit: 20 });

      expect(page.data.map(r => r.keyId)).toEqual(['key-2', 'key-1', 'key-0']);
      expect(page.meta).toEqual({
         limit: 20,
         hasMore: false,
         nextCursor: null,
      });
   });

   it('paginates across pages with a stable cursor and no gaps or repeats', async () => {
      seedMany(7);
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
         const page = await listKeyReports({ limit: 3, cursor });
         seen.push(...page.data.map(r => r.id));
         cursor = page.meta.nextCursor ?? undefined;
         pages++;
         if (cursor) expect(page.meta.hasMore).toBe(true);
      } while (cursor);

      expect(pages).toBe(3);
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
      const expectedOrder = [...db.reports]
         .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
         .map(r => r.id);
      expect(seen).toEqual(expectedOrder);
   });

   it('breaks createdAt ties by id so rows sharing a timestamp are not skipped', async () => {
      const sameTime = new Date(Date.UTC(2026, 10, 20));
      ['a', 'b', 'c', 'd'].forEach(suffix =>
         seedReport({ id: `tie-${suffix}`, createdAt: sameTime })
      );

      const first = await listKeyReports({ limit: 2 });
      const second = await listKeyReports({
         limit: 2,
         cursor: first.meta.nextCursor!,
      });

      expect(first.data.map(r => r.id)).toEqual(['tie-d', 'tie-c']);
      expect(second.data.map(r => r.id)).toEqual(['tie-b', 'tie-a']);
      expect(second.meta.nextCursor).toBeNull();
   });

   it('filters by status, including across pages', async () => {
      seedMany(6); // indices 0,2,4 open; 1,3,5 reviewing
      const first = await listKeyReports({ status: 'open', limit: 2 });
      const second = await listKeyReports({
         status: 'open',
         limit: 2,
         cursor: first.meta.nextCursor!,
      });

      const all = [...first.data, ...second.data];
      expect(all.every(r => r.status === 'open')).toBe(true);
      expect(all.map(r => r.keyId)).toEqual(['key-4', 'key-2', 'key-0']);
      expect(second.meta.hasMore).toBe(false);
   });

   it('rejects a tampered cursor', async () => {
      const valid = encodeCursor({
         createdAt: new Date().toISOString(),
         id: 'x',
      });
      const tampered = `${valid.split('.')[0]}.deadbeef`;
      await expect(
         listKeyReports({ limit: 20, cursor: tampered })
      ).rejects.toBeInstanceOf(InvalidKeyReportCursorError);
   });

   it('rejects a cursor with missing fields or a bad timestamp', async () => {
      await expect(
         listKeyReports({ limit: 20, cursor: encodeCursor({ id: 'x' }) })
      ).rejects.toBeInstanceOf(InvalidKeyReportCursorError);
      await expect(
         listKeyReports({
            limit: 20,
            cursor: encodeCursor({ createdAt: 'not-a-date', id: 'x' }),
         })
      ).rejects.toBeInstanceOf(InvalidKeyReportCursorError);
   });
});

describe('status transitions', () => {
   const allowed: Array<[KeyReportStatusValue, KeyReportStatusValue]> = [
      ['open', 'reviewing'],
      ['open', 'dismissed'],
      ['open', 'actioned'],
      ['reviewing', 'dismissed'],
      ['reviewing', 'actioned'],
   ];

   it('allows exactly the documented transitions', () => {
      for (const from of KEY_REPORT_STATUSES) {
         for (const to of KEY_REPORT_STATUSES) {
            const expected = allowed.some(([f, t]) => f === from && t === to);
            expect(
               `${from}->${to}:${isValidKeyReportTransition(from, to)}`
            ).toBe(`${from}->${to}:${expected}`);
         }
      }
   });

   it.each(allowed)('persists %s -> %s', async (from, to) => {
      const row = seedReport({ status: from });
      const updated = await updateKeyReportStatus(row.id, to);

      expect(updated.status).toBe(to);
      expect(db.reports.find(r => r.id === row.id)!.status).toBe(to);
   });

   it.each([
      ['reviewing', 'reviewing'],
      ['dismissed', 'actioned'],
      ['dismissed', 'reviewing'],
      ['actioned', 'dismissed'],
      ['actioned', 'reviewing'],
   ] as Array<[KeyReportStatusValue, KeyReportStatusValue]>)(
      'rejects %s -> %s without persisting',
      async (from, to) => {
         const row = seedReport({ status: from });
         await expect(updateKeyReportStatus(row.id, to)).rejects.toBeInstanceOf(
            InvalidKeyReportTransitionError
         );
         expect(db.reports.find(r => r.id === row.id)!.status).toBe(from);
         expect(keyReport.updateMany).not.toHaveBeenCalled();
      }
   );

   it('supports the full open -> reviewing -> actioned lifecycle', async () => {
      const row = seedReport();
      await updateKeyReportStatus(row.id, 'reviewing');
      await updateKeyReportStatus(row.id, 'actioned');
      await expect(
         updateKeyReportStatus(row.id, 'dismissed')
      ).rejects.toBeInstanceOf(InvalidKeyReportTransitionError);
      expect(db.reports[0].status).toBe('actioned');
   });

   it('throws KeyReportNotFoundError for an unknown report id', async () => {
      await expect(
         updateKeyReportStatus('missing', 'reviewing')
      ).rejects.toBeInstanceOf(KeyReportNotFoundError);
   });

   it('rejects when a concurrent moderator already moved the report', async () => {
      const row = seedReport({ status: 'open' });
      // Another moderator dismisses the report between our read and write.
      keyReport.updateMany.mockImplementationOnce(async () => {
         row.status = 'dismissed';
         return { count: 0 };
      });

      const err = await updateKeyReportStatus(row.id, 'reviewing').catch(
         e => e
      );
      expect(err).toBeInstanceOf(InvalidKeyReportTransitionError);
      expect(err.message).toContain('"dismissed"');
      expect(row.status).toBe('dismissed');
   });

   it('only updates when the status still matches (compare-and-set)', async () => {
      const row = seedReport({ status: 'open' });
      await updateKeyReportStatus(row.id, 'reviewing');
      expect(keyReport.updateMany).toHaveBeenCalledWith({
         where: { id: row.id, status: 'open' },
         data: { status: 'reviewing' },
      });
   });
});
