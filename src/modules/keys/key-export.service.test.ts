// Unit tests: creator key analytics export (#1014)
// - from/to window scopes every data type (trades, holder snapshots,
//   revenue events, milestone events)
// - CSV + JSON carry all specified fields
// - jobs are queued asynchronously and the signed URL is returned fast
// - signed download tokens reject tampering and expiry

const jobs = new Map<string, any>();
let jobCounter = 0;

const creatorFindFirst = jest.fn();
const tradeFindMany = jest.fn();
const snapshotFindMany = jest.fn();
const activityFindMany = jest.fn();
const milestoneFindMany = jest.fn();
const jobCreate = jest.fn();
const jobFindUnique = jest.fn();
const jobUpdate = jest.fn();

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: { findFirst: (...a: any[]) => creatorFindFirst(...a) },
      trade: { findMany: (...a: any[]) => tradeFindMany(...a) },
      walletHoldingSnapshot: { findMany: (...a: any[]) => snapshotFindMany(...a) },
      activity: { findMany: (...a: any[]) => activityFindMany(...a) },
      creatorReputationHistory: { findMany: (...a: any[]) => milestoneFindMany(...a) },
      keyExportJob: {
         create: (...a: any[]) => jobCreate(...a),
         findUnique: (...a: any[]) => jobFindUnique(...a),
         update: (...a: any[]) => jobUpdate(...a),
      },
   },
}));

import { KeyNotFoundError } from './key-fees.service';
import {
   buildKeyExport,
   buildKeyExportDownloadUrl,
   createKeyExportJob,
   ExportDownloadTokenError,
   KEY_EXPORT_CSV_FIELDS,
   KEY_EXPORT_ROW_LIMIT,
   keyExportQuerySchema,
   processKeyExportJob,
   resolveKeyExportDownload,
   serializeKeyExport,
   signKeyExportToken,
   toCsv,
   verifyKeyExportToken,
   waitForKeyExportQueue,
} from './key-export.service';

const CREATOR = {
   id: 'key-1',
   creatorRoyaltyBuyBps: 500,
   creatorRoyaltySellBps: 300,
};

const dec = (value: string) => ({ toString: () => value });

const TRADES = [
   {
      id: 't1',
      creatorId: 'key-1',
      buyer: 'GA',
      quantity: '2',
      price: '100',
      paymentAsset: 'XLM',
      ledger: 1,
      txHash: 'h1',
      timestamp: new Date('2026-09-01T00:00:00Z'),
      createdAt: new Date('2026-09-01T00:00:00Z'),
   },
   {
      id: 't2',
      creatorId: 'key-1',
      buyer: 'GB',
      quantity: '1',
      price: '150',
      paymentAsset: 'USDC',
      ledger: 2,
      txHash: 'h2',
      timestamp: new Date('2026-09-15T00:00:00Z'),
      createdAt: new Date('2026-09-15T00:00:00Z'),
   },
   {
      id: 't3',
      creatorId: 'key-1',
      buyer: 'GA',
      quantity: '3',
      price: '200',
      paymentAsset: 'XLM',
      ledger: 3,
      txHash: 'h3',
      timestamp: new Date('2026-10-01T00:00:00Z'),
      createdAt: new Date('2026-10-01T00:00:00Z'),
   },
];

const SNAPSHOTS = [
   {
      id: 's1',
      creatorId: 'key-1',
      ownerAddress: 'GA',
      balance: dec('2'),
      recordedAt: new Date('2026-09-01T00:00:00Z'),
   },
   {
      id: 's2',
      creatorId: 'key-1',
      ownerAddress: 'GB',
      balance: dec('1'),
      recordedAt: new Date('2026-09-15T00:00:00Z'),
   },
   {
      id: 's3',
      creatorId: 'key-1',
      ownerAddress: 'GA',
      balance: dec('3'),
      recordedAt: new Date('2026-10-01T00:00:00Z'),
   },
];

const ACTIVITIES = [
   {
      id: 'a1',
      creatorId: 'key-1',
      type: 'DIVIDEND_DISTRIBUTED',
      actor: 'GA',
      payload: { amount: '10' },
      createdAt: new Date('2026-09-15T00:00:00Z'),
   },
   {
      id: 'a2',
      creatorId: 'key-1',
      type: 'DIVIDEND_DISTRIBUTED',
      actor: 'GB',
      payload: { amount: 5 },
      createdAt: new Date('2026-10-01T00:00:00Z'),
   },
];

const MILESTONES = [
   {
      id: 'm1',
      creatorId: 'key-1',
      eventType: 'MILESTONE_REACHED',
      ledger: 5,
      txHash: 'mx1',
      score: 30,
      recordedAt: new Date('2026-09-15T00:00:00Z'),
   },
   {
      id: 'm2',
      creatorId: 'key-1',
      eventType: 'MILESTONE_REACHED',
      ledger: 9,
      txHash: 'mx2',
      score: 60,
      recordedAt: new Date('2026-10-01T00:00:00Z'),
   },
];

function inRange(date: Date, range?: { gte?: Date; lte?: Date }): boolean {
   if (!range) return true;
   if (range.gte && date < range.gte) return false;
   if (range.lte && date > range.lte) return false;
   return true;
}

function sliceTake<T>(rows: T[], take?: number): T[] {
   return typeof take === 'number' ? rows.slice(0, take) : rows;
}

beforeEach(() => {
   jest.clearAllMocks();
   jobs.clear();
   jobCounter = 0;

   creatorFindFirst.mockImplementation(async ({ where }: any) => {
      const values = (where?.OR ?? []).flatMap((clause: any) =>
         Object.values(clause)
      );
      return values.includes('key-1') || values.includes('handle-1')
         ? CREATOR
         : null;
   });

   tradeFindMany.mockImplementation(async ({ where, take }: any) =>
      sliceTake(
         TRADES.filter(
            t => t.creatorId === where.creatorId && inRange(t.timestamp, where.timestamp)
         ),
         take
      )
   );

   snapshotFindMany.mockImplementation(async ({ where, take }: any) =>
      sliceTake(
         SNAPSHOTS.filter(
            s =>
               s.creatorId === where.creatorId &&
               inRange(s.recordedAt, where.recordedAt)
         ),
         take
      )
   );

   activityFindMany.mockImplementation(async ({ where, take }: any) =>
      sliceTake(
         ACTIVITIES.filter(
            a =>
               a.creatorId === where.creatorId &&
               (where.type?.in ?? []).includes(a.type) &&
               inRange(a.createdAt, where.createdAt)
         ),
         take
      )
   );

   milestoneFindMany.mockImplementation(async ({ where, take }: any) =>
      sliceTake(
         MILESTONES.filter(
            m =>
               m.creatorId === where.creatorId &&
               m.eventType === where.eventType &&
               inRange(m.recordedAt, where.recordedAt)
         ),
         take
      )
   );

   jobCreate.mockImplementation(async ({ data }: any) => {
      const id = `job-${++jobCounter}`;
      const job = {
         id,
         ...data,
         status: data.status ?? 'PENDING',
         fileName: null,
         contentType: null,
         content: null,
         recordCount: null,
         error: null,
         startedAt: null,
         completedAt: null,
         createdAt: new Date(),
         updatedAt: new Date(),
      };
      jobs.set(id, job);
      return job;
   });
   jobFindUnique.mockImplementation(async ({ where }: any) => jobs.get(where.id) ?? null);
   jobUpdate.mockImplementation(async ({ where, data }: any) => {
      const job = jobs.get(where.id);
      if (!job) return {};
      Object.assign(job, data);
      return job;
   });
});

afterEach(async () => {
   await waitForKeyExportQueue();
});

describe('keyExportQuerySchema', () => {
   it('defaults format to json', () => {
      expect(keyExportQuerySchema.parse({})).toEqual({
         format: 'json',
         from: undefined,
         to: undefined,
      });
   });

   it('accepts csv and ISO datetimes', () => {
      const parsed = keyExportQuerySchema.parse({
         format: 'csv',
         from: '2026-09-01T00:00:00Z',
         to: '2026-09-30T00:00:00Z',
      });
      expect(parsed.format).toBe('csv');
      expect(parsed.from).toEqual(new Date('2026-09-01T00:00:00Z'));
      expect(parsed.to).toEqual(new Date('2026-09-30T00:00:00Z'));
   });

   it('rejects an unknown format', () => {
      expect(keyExportQuerySchema.safeParse({ format: 'xml' }).success).toBe(false);
   });

   it('rejects from after to', () => {
      expect(
         keyExportQuerySchema.safeParse({
            from: '2026-09-30T00:00:00Z',
            to: '2026-09-01T00:00:00Z',
         }).success
      ).toBe(false);
   });
});

describe('buildKeyExport', () => {
   it('resolves a handle to the creator id and returns every section', async () => {
      const data = await buildKeyExport('handle-1');

      expect(data.keyId).toBe('key-1');
      expect(data.trades).toHaveLength(3);
      expect(data.holderSnapshots).toHaveLength(3);
      expect(data.revenueEvents).toHaveLength(2);
      expect(data.milestoneEvents).toHaveLength(2);
      expect(data.summary).toMatchObject({
         tradeCount: 3,
         holderSnapshotCount: 3,
         revenueEventCount: 2,
         milestoneEventCount: 2,
         truncated: false,
      });
   });

   it('includes every specified field per record type', async () => {
      const data = await buildKeyExport('key-1');

      expect(data.trades[0]).toEqual({
         id: 't1',
         timestamp: '2026-09-01T00:00:00.000Z',
         buyer: 'GA',
         quantity: '2',
         price: '100',
         paymentAsset: 'XLM',
         value: '200',
         ledger: 1,
         txHash: 'h1',
      });
      expect(data.holderSnapshots[0]).toEqual({
         id: 's1',
         ownerAddress: 'GA',
         balance: '2',
         recordedAt: '2026-09-01T00:00:00.000Z',
      });
      expect(data.revenueEvents[0]).toEqual({
         id: 'a1',
         eventType: 'DIVIDEND_DISTRIBUTED',
         actor: 'GA',
         amount: '10',
         createdAt: '2026-09-15T00:00:00.000Z',
      });
      expect(data.milestoneEvents[0]).toEqual({
         id: 'm1',
         eventType: 'MILESTONE_REACHED',
         ledger: 5,
         txHash: 'mx1',
         score: 30,
         recordedAt: '2026-09-15T00:00:00.000Z',
      });
   });

   it('applies the from/to window to every data type', async () => {
      const from = new Date('2026-09-10T00:00:00Z');
      const to = new Date('2026-09-30T00:00:00Z');

      const data = await buildKeyExport('key-1', { from, to });

      expect(data.trades.map(t => t.id)).toEqual(['t2']);
      expect(data.holderSnapshots.map(s => s.id)).toEqual(['s2']);
      expect(data.revenueEvents.map(e => e.id)).toEqual(['a1']);
      expect(data.milestoneEvents.map(m => m.id)).toEqual(['m1']);
      expect(data.from).toBe(from.toISOString());
      expect(data.to).toBe(to.toISOString());

      expect(tradeFindMany).toHaveBeenCalledWith(
         expect.objectContaining({
            where: { creatorId: 'key-1', timestamp: { gte: from, lte: to } },
         })
      );
      expect(snapshotFindMany).toHaveBeenCalledWith(
         expect.objectContaining({
            where: { creatorId: 'key-1', recordedAt: { gte: from, lte: to } },
         })
      );
      expect(activityFindMany).toHaveBeenCalledWith(
         expect.objectContaining({
            where: {
               creatorId: 'key-1',
               type: { in: ['DIVIDEND_DISTRIBUTED'] },
               createdAt: { gte: from, lte: to },
            },
         })
      );
      expect(milestoneFindMany).toHaveBeenCalledWith(
         expect.objectContaining({
            where: {
               creatorId: 'key-1',
               eventType: 'MILESTONE_REACHED',
               recordedAt: { gte: from, lte: to },
            },
         })
      );
   });

   it('computes the revenue breakdown from all trades in range', async () => {
      const data = await buildKeyExport('key-1');

      // 100*2 + 150*1 + 200*3 = 950
      expect(data.revenueBreakdown.tradeCount).toBe(3);
      expect(data.revenueBreakdown.totalTradeVolume).toBe('950');
      // royalty uses the higher of buy (500) and sell (300) bps
      expect(data.revenueBreakdown.totalCreatorRoyalty).toBe(
         ((200n * 500n) / 10000n + (150n * 500n) / 10000n + (600n * 500n) / 10000n).toString()
      );
      // dividend amounts: 10 + 5
      expect(data.revenueBreakdown.totalDividendsDistributed).toBe('15.0000000');
   });

   it('throws KeyNotFoundError for an unknown key', async () => {
      await expect(buildKeyExport('missing')).rejects.toBeInstanceOf(
         KeyNotFoundError
      );
   });

   it('caps oversized sections and flags truncation', async () => {
      const oversized = Array.from({ length: KEY_EXPORT_ROW_LIMIT + 1 }, (_, i) => ({
         id: `big-${i}`,
         creatorId: 'key-1',
         buyer: 'GA',
         quantity: '1',
         price: '1',
         paymentAsset: 'XLM',
         ledger: i,
         txHash: `x-${i}`,
         timestamp: new Date('2026-09-15T00:00:00Z'),
         createdAt: new Date('2026-09-15T00:00:00Z'),
      }));
      tradeFindMany.mockResolvedValueOnce(oversized);

      const data = await buildKeyExport('key-1');
      expect(data.trades).toHaveLength(KEY_EXPORT_ROW_LIMIT);
      expect(data.summary.truncated).toBe(true);
   });
});

describe('serializeKeyExport', () => {
   it('emits a JSON payload with every section', async () => {
      const data = await buildKeyExport('key-1');
      const serialized = serializeKeyExport('json', data);

      expect(serialized.contentType).toContain('application/json');
      expect(serialized.fileName).toMatch(/^key-export-key-1-.*\.json$/);
      expect(serialized.recordCount).toBe(10);

      const parsed = JSON.parse(serialized.content);
      expect(parsed).toMatchObject({ format: 'json', keyId: 'key-1' });
      expect(parsed.trades).toHaveLength(3);
      expect(parsed.holderSnapshots).toHaveLength(3);
      expect(parsed.revenueEvents).toHaveLength(2);
      expect(parsed.milestoneEvents).toHaveLength(2);
      expect(parsed.revenueBreakdown.totalTradeVolume).toBe('950');
   });

   it('emits a CSV whose header contains every declared field', async () => {
      const data = await buildKeyExport('key-1');
      const serialized = serializeKeyExport('csv', data);

      expect(serialized.contentType).toContain('text/csv');
      expect(serialized.fileName).toMatch(/\.csv$/);

      const [header, ...rows] = serialized.content.split('\n');
      expect(header).toBe(KEY_EXPORT_CSV_FIELDS.join(','));
      // 3 trades + 3 snapshots + 2 revenue events + 1 breakdown + 2 milestones
      expect(rows).toHaveLength(11);
      expect(serialized.content).toContain('trade');
      expect(serialized.content).toContain('holder_snapshot');
      expect(serialized.content).toContain('revenue_event');
      expect(serialized.content).toContain('revenue_breakdown');
      expect(serialized.content).toContain('milestone_event');
   });

   it('escapes commas, quotes and newlines', () => {
      const csv = toCsv([{ record_type: 'trade', buyer: 'A,"B"\nC' }]);
      expect(csv).toContain('"A,""B""\nC"');
   });
});

describe('signed download tokens', () => {
   it('round-trips a valid token', () => {
      const expiresAt = new Date(Date.now() + 60_000);
      const token = signKeyExportToken('job-1', expiresAt);
      expect(verifyKeyExportToken(token)).toEqual({
         jobId: 'job-1',
         exp: Math.floor(expiresAt.getTime() / 1000),
      });
   });

   it('rejects a tampered signature', () => {
      const token = signKeyExportToken('job-1', new Date(Date.now() + 60_000));
      expect(() => verifyKeyExportToken(`${token}x`)).toThrow(
         ExportDownloadTokenError
      );
   });

   it('rejects a tampered payload', () => {
      const token = signKeyExportToken('job-1', new Date(Date.now() + 60_000));
      const [, signature] = token.split('.');
      const forged = Buffer.from(JSON.stringify({ jobId: 'job-2', exp: 9e9 })).toString(
         'base64url'
      );
      expect(() => verifyKeyExportToken(`${forged}.${signature}`)).toThrow(
         ExportDownloadTokenError
      );
   });

   it('rejects an expired token', () => {
      const token = signKeyExportToken('job-1', new Date(Date.now() - 1000));
      expect(() => verifyKeyExportToken(token)).toThrow(/expired/i);
   });

   it('builds a download URL pointing at the keys download route', () => {
      const url = buildKeyExportDownloadUrl('job-1', 'tok');
      expect(url).toBe(
         'http://localhost:3000/api/v1/keys/exports/job-1/download?token=tok'
      );
   });
});

describe('createKeyExportJob', () => {
   it('returns a signed URL quickly and generates in the background', async () => {
      const start = Date.now();
      const accepted = await createKeyExportJob({
         keyId: 'key-1',
         requestedBy: 'G-CREATOR',
         format: 'csv',
      });
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(5000);
      expect(accepted.status).toBe('PENDING');
      expect(accepted.downloadUrl).toContain(
         `/api/v1/keys/exports/${accepted.jobId}/download?token=`
      );

      await waitForKeyExportQueue();

      const job = jobs.get(accepted.jobId);
      expect(job.status).toBe('READY');
      expect(job.contentType).toContain('text/csv');
      expect(job.content).toContain('trade');
      expect(job.recordCount).toBe(10);
   });

   it('serves a completed export through the signed URL', async () => {
      const accepted = await createKeyExportJob({
         keyId: 'key-1',
         requestedBy: 'G-CREATOR',
         format: 'json',
         from: new Date('2026-09-10T00:00:00Z'),
         to: new Date('2026-09-30T00:00:00Z'),
      });
      await waitForKeyExportQueue();

      const token = new URL(accepted.downloadUrl).searchParams.get('token')!;
      const resolution = await resolveKeyExportDownload(accepted.jobId, token);

      expect(resolution.kind).toBe('ready');
      if (resolution.kind === 'ready') {
         expect(resolution.fileName).toMatch(/\.json$/);
         const parsed = JSON.parse(resolution.content);
         expect(parsed.trades.map((t: any) => t.id)).toEqual(['t2']);
      }
   });

   it('reports a pending job while it is still generating', async () => {
      const expiresAt = new Date(Date.now() + 60_000);
      jobs.set('job-pending', {
         id: 'job-pending',
         keyId: 'key-1',
         format: 'json',
         status: 'PROCESSING',
         content: null,
         expiresAt,
      });
      const token = signKeyExportToken('job-pending', expiresAt);

      const resolution = await resolveKeyExportDownload('job-pending', token);
      expect(resolution).toEqual({ kind: 'pending', status: 'PROCESSING' });
   });

   it('reports an expired link after the TTL elapses', async () => {
      const expiresAt = new Date(Date.now() + 60_000);
      jobs.set('job-late', {
         id: 'job-late',
         keyId: 'key-1',
         format: 'json',
         status: 'READY',
         content: '{}',
         expiresAt: new Date(Date.now() - 1000),
      });
      // token itself is still cryptographically valid
      const token = signKeyExportToken('job-late', expiresAt);

      const resolution = await resolveKeyExportDownload('job-late', token);
      expect(resolution).toEqual({ kind: 'expired' });
   });

   it('rejects a token minted for a different job', async () => {
      const token = signKeyExportToken('job-x', new Date(Date.now() + 60_000));
      await expect(resolveKeyExportDownload('job-y', token)).rejects.toBeInstanceOf(
         ExportDownloadTokenError
      );
   });
});

describe('processKeyExportJob', () => {
   it('marks a job FAILED when generation throws', async () => {
      const accepted = await createKeyExportJob({
         keyId: 'key-1',
         requestedBy: 'G-CREATOR',
         format: 'json',
      });
      await waitForKeyExportQueue();

      // A second run: force the creator lookup to fail so generation throws.
      jobs.set('job-fail', {
         id: 'job-fail',
         keyId: 'key-1',
         format: 'json',
         status: 'PENDING',
         content: null,
         expiresAt: new Date(Date.now() + 60_000),
      });
      creatorFindFirst.mockResolvedValueOnce(null);

      await processKeyExportJob('job-fail');

      expect(jobs.get('job-fail').status).toBe('FAILED');
      expect(jobs.get('job-fail').error).toContain('Key not found');
      expect(accepted.jobId).toBeDefined();
   });
});
