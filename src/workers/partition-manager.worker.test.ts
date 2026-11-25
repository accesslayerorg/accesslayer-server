import { ensureFuturePartitions, detachOldPartitions } from './partition-manager.worker';

describe('partition-manager.worker', () => {
   it('creates future monthly partitions when table is partitioned', async () => {
      const executeRawUnsafe = jest.fn().mockResolvedValue(0);
      const queryRawUnsafe = jest
         .fn()
         .mockResolvedValueOnce([{ relkind: 'p' }]) // tableIsPartitioned
         .mockResolvedValueOnce([]) // partition exists month 0
         .mockResolvedValueOnce([]) // month 1
         .mockResolvedValueOnce([]); // month 2

      const created = await ensureFuturePartitions('trades', 3, {
         executeRawUnsafe,
         queryRawUnsafe,
         now: () => new Date('2026-11-24T00:00:00Z'),
      });

      expect(created).toEqual(['trades_2026_11', 'trades_2026_12', 'trades_2027_01']);
      expect(executeRawUnsafe).toHaveBeenCalledTimes(3);
      expect(executeRawUnsafe.mock.calls[0][0]).toContain('CREATE TABLE IF NOT EXISTS "trades_2026_11" PARTITION OF "trades"');
   });

   it('detaches partitions older than retention cutoff', async () => {
      const executeRawUnsafe = jest.fn().mockResolvedValue(0);
      const queryRawUnsafe = jest
         .fn()
         .mockResolvedValueOnce([{ relkind: 'p' }])
         .mockResolvedValueOnce([
            { name: 'trades_2025_01', bound: "FOR VALUES FROM ('2025-01-01T00:00:00.000Z') TO ('2025-02-01T00:00:00.000Z')" },
            { name: 'trades_2026_10', bound: "FOR VALUES FROM ('2026-10-01T00:00:00.000Z') TO ('2026-11-01T00:00:00.000Z')" },
         ]);

      const detached = await detachOldPartitions('trades', 6, {
         executeRawUnsafe,
         queryRawUnsafe,
         now: () => new Date('2026-11-24T00:00:00Z'),
      });

      expect(detached).toEqual(['trades_2025_01']);
      expect(executeRawUnsafe).toHaveBeenCalledWith(
         'ALTER TABLE "trades" DETACH PARTITION "trades_2025_01" CONCURRENTLY'
      );
   });

   it('no-ops when table is not partitioned', async () => {
      const executeRawUnsafe = jest.fn();
      const queryRawUnsafe = jest.fn().mockResolvedValue([{ relkind: 'r' }]);
      const created = await ensureFuturePartitions('trades', 3, {
         executeRawUnsafe,
         queryRawUnsafe,
         now: () => new Date('2026-11-24T00:00:00Z'),
      });
      expect(created).toEqual([]);
      expect(executeRawUnsafe).not.toHaveBeenCalled();
   });
});
