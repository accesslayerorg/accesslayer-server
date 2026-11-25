import {
   millisecondsUntilNextRetentionRun,
   RETENTION_BATCH_SIZE,
   RETENTION_BATCH_PAUSE_MS,
   runRetentionWorker,
} from './retention.worker';
import {
   resetRetentionMetrics,
   getRetentionMetrics,
} from '../utils/retention-metrics.utils';

describe('Retention worker', () => {
   beforeEach(() => resetRetentionMetrics());

   it('deletes no more than 1,000 rows per batch and pauses between full batches', async () => {
      const executeRawUnsafe = jest
         .fn<Promise<number>, [string, ...unknown[]]>()
         .mockResolvedValueOnce(RETENTION_BATCH_SIZE)
         .mockResolvedValueOnce(3);
      const pause = jest.fn().mockResolvedValue(undefined);
      const recordRun = jest.fn().mockResolvedValue(undefined);

      const results = await runRetentionWorker({
         executeRawUnsafe,
         pause,
         recordRun,
         dryRun: false,
         rules: [
            {
               tableName: 'session_activity',
               timestampColumn: 'timestamp',
               maxAgeDays: 30,
            },
         ],
         now: () => new Date('2026-11-23T03:00:00.000Z'),
         pruneNonces: () => 0,
      });

      expect(results[0]).toMatchObject({ rowsDeleted: 1003, dryRun: false });
      expect(executeRawUnsafe).toHaveBeenCalledTimes(2);
      expect(executeRawUnsafe.mock.calls[0][0]).toContain('LIMIT $2');
      expect(executeRawUnsafe.mock.calls[0][2]).toBe(RETENTION_BATCH_SIZE);
      expect(pause).toHaveBeenCalledTimes(1);
      expect(pause).toHaveBeenCalledWith(RETENTION_BATCH_PAUSE_MS);
      expect(recordRun).toHaveBeenCalledWith(
         expect.objectContaining({
            tableName: 'session_activity',
            rowsDeleted: 1003,
         })
      );
      expect(getRetentionMetrics()).toEqual([
         { table: 'session_activity', value: 1003 },
      ]);
   });

   it('counts eligible rows without deleting in dry-run mode', async () => {
      const queryRawUnsafe = jest.fn().mockResolvedValue([{ count: 8 }]);
      const executeRawUnsafe = jest.fn();
      const recordRun = jest.fn().mockResolvedValue(undefined);

      const results = await runRetentionWorker({
         queryRawUnsafe,
         executeRawUnsafe,
         recordRun,
         dryRun: true,
         rules: [
            {
               tableName: 'WebhookEvent',
               timestampColumn: 'createdAt',
               maxAgeDays: 30,
               statusColumn: 'status',
               eligibleStatuses: ['DELIVERED', 'FAILED'],
            },
         ],
         now: () => new Date('2026-11-23T03:00:00.000Z'),
         pruneNonces: () => 0,
      });

      expect(results[0]).toMatchObject({
         rowsDeleted: 0,
         rowsWouldDelete: 8,
         dryRun: true,
      });
      expect(queryRawUnsafe.mock.calls[0][0]).toContain(
         '"createdAt" < $1 AND "status"::text IN ($2, $3)'
      );
      expect(queryRawUnsafe.mock.calls[0][1]).toEqual(
         new Date('2026-10-24T03:00:00.000Z')
      );
      expect(queryRawUnsafe.mock.calls[0].slice(2)).toEqual([
         'DELIVERED',
         'FAILED',
      ]);
      expect(executeRawUnsafe).not.toHaveBeenCalled();
      expect(recordRun).toHaveBeenCalledWith(
         expect.objectContaining({
            tableName: 'WebhookEvent',
            rowsDeleted: 0,
            dryRun: true,
         })
      );
      expect(getRetentionMetrics()).toEqual([]);
   });

   it('continues to later tables when one table fails', async () => {
      const executeRawUnsafe = jest
         .fn<Promise<number>, [string, ...unknown[]]>()
         .mockRejectedValueOnce(new Error('table unavailable'))
         .mockResolvedValueOnce(2);
      const recordRun = jest.fn().mockResolvedValue(undefined);

      const results = await runRetentionWorker({
         executeRawUnsafe,
         recordRun,
         dryRun: false,
         rules: [
            {
               tableName: 'broken_table',
               timestampColumn: 'createdAt',
               maxAgeDays: 1,
            },
            {
               tableName: 'working_table',
               timestampColumn: 'createdAt',
               maxAgeDays: 1,
            },
         ],
         pruneNonces: () => 0,
      });

      expect(results[0].error).toBe('table unavailable');
      expect(results[1]).toMatchObject({
         tableName: 'working_table',
         rowsDeleted: 2,
      });
      expect(recordRun).toHaveBeenCalledTimes(2);
   });

   it('schedules the next run at 03:00 UTC', () => {
      expect(
         millisecondsUntilNextRetentionRun(new Date('2026-11-23T02:00:00.000Z'))
      ).toBe(60 * 60 * 1000);
      expect(
         millisecondsUntilNextRetentionRun(new Date('2026-11-23T03:00:00.000Z'))
      ).toBe(24 * 60 * 60 * 1000);
      expect(
         millisecondsUntilNextRetentionRun(new Date('2026-11-23T04:00:00.000Z'))
      ).toBe(23 * 60 * 60 * 1000);
   });
});
