jest.mock('../config', () => ({
   envConfig: {
      OWNERSHIP_SNAPSHOT_CLEANUP_DRY_RUN: true,
      OWNERSHIP_SNAPSHOT_RETENTION_DAYS: 30,
      OWNERSHIP_SNAPSHOT_TABLE_NAME: 'creator_ownership_snapshots',
      OWNERSHIP_SNAPSHOT_CLEANUP_ENABLED: false,
      OWNERSHIP_SNAPSHOT_CLEANUP_INTERVAL_MINUTES: 60,
   },
}));

jest.mock('../utils/prisma.utils', () => ({
   prisma: {
      $queryRawUnsafe: jest.fn(),
      $executeRawUnsafe: jest.fn(),
   },
}));

jest.mock('../utils/logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
   },
}));

import { envConfig } from '../config';
import { cleanupExpiredOwnershipSnapshots } from './ownership-snapshot-cleanup.job';

describe('ownership-snapshot-cleanup.job', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      envConfig.OWNERSHIP_SNAPSHOT_CLEANUP_DRY_RUN = true;
      envConfig.OWNERSHIP_SNAPSHOT_RETENTION_DAYS = 30;
      envConfig.OWNERSHIP_SNAPSHOT_TABLE_NAME = 'creator_ownership_snapshots';
   });

   it('returns skipped when the snapshot table does not exist', async () => {
      const queryRawUnsafe = jest
         .fn()
         .mockResolvedValueOnce([{ regclass: null }]);

      const result = await cleanupExpiredOwnershipSnapshots({
         queryRawUnsafe,
         now: () => new Date('2026-01-31T00:00:00.000Z'),
      });

      expect(result).toMatchObject({
         skipped: true,
         reason: 'table_not_found',
         dryRun: true,
         affectedRows: 0,
         tableName: 'creator_ownership_snapshots',
      });
      expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
   });

   it('counts rows in dry-run mode', async () => {
      const queryRawUnsafe = jest
         .fn()
         .mockResolvedValueOnce([{ regclass: 'creator_ownership_snapshots' }])
         .mockResolvedValueOnce([{ count: 12 }]);
      const executeRawUnsafe = jest.fn();

      const result = await cleanupExpiredOwnershipSnapshots({
         queryRawUnsafe,
         executeRawUnsafe,
         now: () => new Date('2026-01-31T00:00:00.000Z'),
      });

      expect(result).toMatchObject({
         skipped: false,
         dryRun: true,
         affectedRows: 12,
         tableName: 'creator_ownership_snapshots',
      });
      expect(queryRawUnsafe).toHaveBeenCalledTimes(2);
      expect(executeRawUnsafe).not.toHaveBeenCalled();
   });

   it('deletes rows when dry-run is disabled', async () => {
      envConfig.OWNERSHIP_SNAPSHOT_CLEANUP_DRY_RUN = false;

      const queryRawUnsafe = jest
         .fn()
         .mockResolvedValueOnce([{ regclass: 'creator_ownership_snapshots' }]);
      const executeRawUnsafe = jest.fn().mockResolvedValueOnce(5);

      const result = await cleanupExpiredOwnershipSnapshots({
         queryRawUnsafe,
         executeRawUnsafe,
         now: () => new Date('2026-01-31T00:00:00.000Z'),
      });

      expect(result).toMatchObject({
         skipped: false,
         dryRun: false,
         affectedRows: 5,
         tableName: 'creator_ownership_snapshots',
      });
      expect(executeRawUnsafe).toHaveBeenCalledTimes(1);
   });

   it('applies retention days when calculating cutoff timestamp', async () => {
      envConfig.OWNERSHIP_SNAPSHOT_RETENTION_DAYS = 10;

      const queryRawUnsafe = jest
         .fn()
         .mockResolvedValueOnce([{ regclass: 'creator_ownership_snapshots' }])
         .mockResolvedValueOnce([{ count: 0 }]);

      const now = new Date('2026-02-15T00:00:00.000Z');
      const expectedCutoff = new Date('2026-02-05T00:00:00.000Z');

      const result = await cleanupExpiredOwnershipSnapshots({
         queryRawUnsafe,
         now: () => now,
      });

      expect(result.cutoffTimestamp.toISOString()).toBe(
         expectedCutoff.toISOString()
      );
      expect(queryRawUnsafe).toHaveBeenLastCalledWith(
         expect.stringContaining('COUNT(*)::int'),
         expectedCutoff
      );
   });
});
