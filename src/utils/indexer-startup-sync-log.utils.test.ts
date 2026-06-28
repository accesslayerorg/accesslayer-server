import { logIndexerStartupSyncState } from './indexer-startup-sync-log.utils';
import { prisma } from './prisma.utils';
import { logger } from './logger.utils';

jest.mock('./prisma.utils', () => ({
   prisma: {
      indexerCursor: {
         findFirst: jest.fn(),
      },
   },
}));

jest.mock('./logger.utils', () => ({
   logger: {
      info: jest.fn(),
      warn: jest.fn(),
   },
}));

describe('logIndexerStartupSyncState', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('should emit info log with correct fields when ledger has been processed', async () => {
      const mockFindFirst = prisma.indexerCursor.findFirst as jest.Mock;
      mockFindFirst.mockResolvedValue({ last_ledger_sequence: 1000 });

      await logIndexerStartupSyncState(1500);

      expect(logger.info).toHaveBeenCalledWith(
         {
            last_processed_ledger: 1000,
            current_network_ledger: 1500,
            lag_in_ledgers: 500,
            estimated_catchup_seconds: 2500, // 500 * 5
         },
         'Indexer startup sync state'
      );
   });

   it('should emit warning when no ledger has been processed', async () => {
      const mockFindFirst = prisma.indexerCursor.findFirst as jest.Mock;
      mockFindFirst.mockResolvedValue(null);

      await logIndexerStartupSyncState(2000);

      expect(logger.warn).toHaveBeenCalledWith(
         {
            current_network_ledger: 2000,
            indexer_state: 'fresh_start',
         },
         'Indexer starting from scratch — no ledger has been processed yet'
      );
      expect(logger.info).not.toHaveBeenCalled();
   });

   it('should emit warning when last_ledger_sequence is null', async () => {
      const mockFindFirst = prisma.indexerCursor.findFirst as jest.Mock;
      mockFindFirst.mockResolvedValue({ last_ledger_sequence: null });

      await logIndexerStartupSyncState(3000);

      expect(logger.warn).toHaveBeenCalledWith(
         {
            current_network_ledger: 3000,
            indexer_state: 'fresh_start',
         },
         'Indexer starting from scratch — no ledger has been processed yet'
      );
   });

   it('should calculate estimated catchup seconds correctly', async () => {
      const mockFindFirst = prisma.indexerCursor.findFirst as jest.Mock;
      mockFindFirst.mockResolvedValue({ last_ledger_sequence: 100 });

      await logIndexerStartupSyncState(200);

      expect(logger.info).toHaveBeenCalledWith(
         expect.objectContaining({
            lag_in_ledgers: 100,
            estimated_catchup_seconds: 500, // 100 * 5
         }),
         expect.any(String)
      );
   });

   it('should handle zero lag correctly', async () => {
      const mockFindFirst = prisma.indexerCursor.findFirst as jest.Mock;
      mockFindFirst.mockResolvedValue({ last_ledger_sequence: 5000 });

      await logIndexerStartupSyncState(5000);

      expect(logger.info).toHaveBeenCalledWith(
         {
            last_processed_ledger: 5000,
            current_network_ledger: 5000,
            lag_in_ledgers: 0,
            estimated_catchup_seconds: 0,
         },
         'Indexer startup sync state'
      );
   });

   it('should handle large lag correctly', async () => {
      const mockFindFirst = prisma.indexerCursor.findFirst as jest.Mock;
      mockFindFirst.mockResolvedValue({ last_ledger_sequence: 1000000 });

      await logIndexerStartupSyncState(2000000);

      expect(logger.info).toHaveBeenCalledWith(
         {
            last_processed_ledger: 1000000,
            current_network_ledger: 2000000,
            lag_in_ledgers: 1000000,
            estimated_catchup_seconds: 5000000, // 1M * 5
         },
         'Indexer startup sync state'
      );
   });
});
