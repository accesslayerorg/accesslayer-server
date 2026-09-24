jest.mock('../config', () => ({
   envConfig: {
      PRICE_HISTORY_CLEANUP_DRY_RUN: true,
      PRICE_HISTORY_RETENTION_DAYS: 30,
      PRICE_HISTORY_TABLE_NAME: 'creator_price_history',
      PRICE_HISTORY_CLEANUP_ENABLED: false,
      PRICE_HISTORY_CLEANUP_INTERVAL_MINUTES: 60,
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
import { logger } from '../utils/logger.utils';
import { cleanupExpiredPriceHistory } from './price-history-cleanup.job';

describe('price-history-cleanup.job', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      envConfig.PRICE_HISTORY_CLEANUP_DRY_RUN = true;
      envConfig.PRICE_HISTORY_RETENTION_DAYS = 30;
      envConfig.PRICE_HISTORY_TABLE_NAME = 'creator_price_history';
   });

   it('returns skipped when the history table does not exist', async () => {
      const queryRawUnsafe = jest.fn().mockResolvedValueOnce([{ regclass: null }]);

      const result = await cleanupExpiredPriceHistory({
         queryRawUnsafe,
         now: () => new Date('2026-01-31T00:00:00.000Z'),
      });

      expect(result).toMatchObject({
         skipped: true,
         reason: 'table_not_found',
         dryRun: true,
         affectedRows: 0,
         tableName: 'creator_price_history',
      });
      expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
   });

   it('counts rows instead of deleting them in dry-run mode', async () => {
      const queryRawUnsafe = jest
         .fn()
         .mockResolvedValueOnce([{ regclass: 'creator_price_history' }])
         .mockResolvedValueOnce([{ count: 42 }]);
      const executeRawUnsafe = jest.fn();

      const result = await cleanupExpiredPriceHistory({
         queryRawUnsafe,
         executeRawUnsafe,
         now: () => new Date('2026-01-31T00:00:00.000Z'),
      });

      expect(result).toMatchObject({
         skipped: false,
         dryRun: true,
         affectedRows: 42,
      });
      expect(result.cutoffTimestamp.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(executeRawUnsafe).not.toHaveBeenCalled();
   });

   it('deletes rows older than the retention window when dry-run is off', async () => {
      envConfig.PRICE_HISTORY_CLEANUP_DRY_RUN = false;
      const queryRawUnsafe = jest
         .fn()
         .mockResolvedValueOnce([{ regclass: 'creator_price_history' }]);
      const executeRawUnsafe = jest.fn().mockResolvedValue(7);

      const result = await cleanupExpiredPriceHistory({
         queryRawUnsafe,
         executeRawUnsafe,
         now: () => new Date('2026-01-31T00:00:00.000Z'),
      });

      expect(result).toMatchObject({
         skipped: false,
         dryRun: false,
         affectedRows: 7,
      });
      expect(executeRawUnsafe).toHaveBeenCalledTimes(1);
      const [sql, cutoff] = executeRawUnsafe.mock.calls[0] as [string, Date];
      expect(sql).toContain('DELETE FROM "creator_price_history"');
      expect(sql).toContain('"recordedAt" < $1');
      expect(cutoff.toISOString()).toBe('2026-01-01T00:00:00.000Z');
   });

   it('honours a custom retention window and rejects an unsafe table name', async () => {
      envConfig.PRICE_HISTORY_CLEANUP_DRY_RUN = false;
      envConfig.PRICE_HISTORY_RETENTION_DAYS = 7;
      const queryRawUnsafe = jest
         .fn()
         .mockResolvedValueOnce([{ regclass: 'creator_price_history' }]);
      const executeRawUnsafe = jest.fn().mockResolvedValue(1);

      const result = await cleanupExpiredPriceHistory({
         queryRawUnsafe,
         executeRawUnsafe,
         now: () => new Date('2026-01-31T00:00:00.000Z'),
      });
      expect(result.cutoffTimestamp.toISOString()).toBe('2026-01-24T00:00:00.000Z');

      envConfig.PRICE_HISTORY_TABLE_NAME = 'creator_price_history"; DROP TABLE users; --';
      await expect(
         cleanupExpiredPriceHistory({ queryRawUnsafe, executeRawUnsafe })
      ).rejects.toThrow(/Invalid PRICE_HISTORY_TABLE_NAME/);
   });

   it('logs and swallows nothing when the table is missing (warn only)', async () => {
      const queryRawUnsafe = jest.fn().mockResolvedValueOnce([{ regclass: null }]);

      await cleanupExpiredPriceHistory({ queryRawUnsafe });
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
   });
});
