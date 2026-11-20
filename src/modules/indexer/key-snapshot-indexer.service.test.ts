jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      $executeRaw: jest.fn(),
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/indexer-dlq.utils', () => ({
   moveToDLQ: jest.fn().mockResolvedValue({}),
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
      isLevelEnabled: jest.fn().mockReturnValue(false),
   },
}));

import {
   parseSnapshotTakenEvent,
   processSnapshotTakenEvent,
   processSnapshotTakenEvents,
   toUtcDay,
   KEY_SNAPSHOT_INDEXER_DLQ_JOB_TYPE,
} from './key-snapshot-indexer.service';
import { prisma } from '../../utils/prisma.utils';
import { cacheInvalidate } from '../../utils/redis.utils';
import { moveToDLQ } from '../../utils/indexer-dlq.utils';
import { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';

const mockExec = (prisma as any).$executeRaw as jest.Mock;
const mockInvalidate = cacheInvalidate as jest.Mock;
const mockDlq = moveToDLQ as jest.Mock;

const TAKEN_AT = '2026-10-26T23:59:00.000Z';

function snapshotEvent(
   overrides: Record<string, unknown> = {}
): IndexerChainEvent {
   return {
      txHash: 'tx-1',
      eventIndex: 0,
      eventType: 'SnapshotTaken',
      ledger: 5000,
      creatorId: 'key-1',
      price: '12500000',
      volume: '980000000',
      holder_count: 42,
      market_cap: '525000000',
      timestamp: TAKEN_AT,
      ...overrides,
   };
}

beforeEach(() => {
   jest.clearAllMocks();
   mockExec.mockResolvedValue(1);
});

describe('parseSnapshotTakenEvent', () => {
   it('parses all four metrics from a snake_case event', () => {
      const result = parseSnapshotTakenEvent(snapshotEvent());
      expect(result).toEqual({
         ok: true,
         value: {
            creatorId: 'key-1',
            snapshotDate: new Date('2026-10-26T00:00:00.000Z'),
            price: 12500000n,
            volume: 980000000n,
            holderCount: 42,
            marketCap: 525000000n,
            takenAt: new Date(TAKEN_AT),
            ledger: 5000,
            txHash: 'tx-1',
            eventIndex: 0,
         },
      });
   });

   it('accepts camelCase fields and keyId', () => {
      const result = parseSnapshotTakenEvent(
         snapshotEvent({
            creatorId: undefined,
            keyId: 'key-2',
            holder_count: undefined,
            holderCount: '7',
            market_cap: undefined,
            marketCap: 100n,
            timestamp: undefined,
            takenAt: TAKEN_AT,
         })
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
         expect(result.value.creatorId).toBe('key-2');
         expect(result.value.holderCount).toBe(7);
         expect(result.value.marketCap).toBe(100n);
      }
   });

   it('keeps values above Number.MAX_SAFE_INTEGER exact', () => {
      const big = '9007199254740993';
      const result = parseSnapshotTakenEvent(
         snapshotEvent({ price: big, market_cap: BigInt(big) })
      );
      expect(result.ok && result.value.price).toBe(BigInt(big));
      expect(result.ok && result.value.marketCap).toBe(BigInt(big));
   });

   it('reads epoch seconds and epoch milliseconds timestamps', () => {
      const secs = Math.floor(Date.parse(TAKEN_AT) / 1000);
      const fromSecs = parseSnapshotTakenEvent(
         snapshotEvent({ timestamp: secs })
      );
      const fromMs = parseSnapshotTakenEvent(
         snapshotEvent({ timestamp: String(secs * 1000) })
      );
      expect(fromSecs.ok && fromSecs.value.takenAt.toISOString()).toBe(
         TAKEN_AT
      );
      expect(fromMs.ok && fromMs.value.takenAt.toISOString()).toBe(TAKEN_AT);
   });

   it.each([
      ['creatorId', { creatorId: '' }],
      ['price', { price: undefined }],
      ['price', { price: '-1' }],
      ['volume', { volume: 1.5 }],
      ['holder_count', { holder_count: -3 }],
      ['holder_count', { holder_count: undefined }],
      ['market_cap', { market_cap: 'abc' }],
      ['timestamp', { timestamp: 'not-a-date' }],
      ['ledger', { ledger: undefined }],
      ['txHash/eventIndex', { txHash: '' }],
   ])('rejects an invalid %s', (field, overrides) => {
      const result = parseSnapshotTakenEvent(snapshotEvent(overrides));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain(field);
   });
});

describe('toUtcDay', () => {
   it('truncates to midnight UTC', () => {
      expect(toUtcDay(new Date('2026-10-27T23:30:00+01:00'))).toEqual(
         new Date('2026-10-27T00:00:00.000Z')
      );
   });
});

describe('processSnapshotTakenEvent', () => {
   it('upserts the snapshot and invalidates every range for the key', async () => {
      await expect(processSnapshotTakenEvent(snapshotEvent())).resolves.toBe(
         true
      );
      expect(mockExec).toHaveBeenCalledTimes(1);
      const [strings, ...values] = mockExec.mock.calls[0];
      const sql = (strings as string[]).join('?');
      expect(sql).toContain('ON CONFLICT ("creatorId", "snapshotDate")');
      expect(sql).toContain('< (EXCLUDED."ledger", EXCLUDED."eventIndex")');
      expect(values).toEqual(
         expect.arrayContaining([
            'key-1',
            12500000n,
            980000000n,
            42,
            525000000n,
            5000,
            'tx-1',
            0,
         ])
      );
      expect(mockInvalidate).toHaveBeenCalledWith(
         'key-snapshots:key-1:7d',
         'key-snapshots:key-1:30d',
         'key-snapshots:key-1:90d',
         'key-snapshots:key-1:all'
      );
   });

   it('invalidates after the write, never before', async () => {
      const order: string[] = [];
      mockExec.mockImplementation(async () => {
         order.push('write');
         return 1;
      });
      mockInvalidate.mockImplementation(async () => {
         order.push('invalidate');
      });
      await processSnapshotTakenEvent(snapshotEvent());
      expect(order).toEqual(['write', 'invalidate']);
   });

   it('returns false for a stale or duplicate event but still invalidates', async () => {
      mockExec.mockResolvedValue(0);
      await expect(processSnapshotTakenEvent(snapshotEvent())).resolves.toBe(
         false
      );
      expect(mockInvalidate).toHaveBeenCalledTimes(1);
   });

   it('sends malformed events to the DLQ without writing', async () => {
      await expect(
         processSnapshotTakenEvent(snapshotEvent({ price: undefined }))
      ).resolves.toBe(false);
      expect(mockExec).not.toHaveBeenCalled();
      expect(mockInvalidate).not.toHaveBeenCalled();
      expect(mockDlq).toHaveBeenCalledWith(
         expect.objectContaining({
            jobType: KEY_SNAPSHOT_INDEXER_DLQ_JOB_TYPE,
            failureReason: 'missing or invalid price',
         })
      );
   });

   it('rethrows database errors so the cursor does not advance', async () => {
      mockExec.mockRejectedValue(new Error('db down'));
      await expect(processSnapshotTakenEvent(snapshotEvent())).rejects.toThrow(
         'db down'
      );
      expect(mockInvalidate).not.toHaveBeenCalled();
   });
});

describe('processSnapshotTakenEvents', () => {
   it('processes only SnapshotTaken events in a mixed batch', async () => {
      await processSnapshotTakenEvents([
         snapshotEvent(),
         snapshotEvent({ eventType: 'KEY_BOUGHT', txHash: 'tx-2' }),
         snapshotEvent({ eventType: 'SNAPSHOT_TAKEN', txHash: 'tx-3' }),
      ]);
      expect(mockExec).toHaveBeenCalledTimes(2);
   });
});
