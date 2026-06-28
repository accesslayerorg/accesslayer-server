import {
   checkIndexerCursorStalenessFromStore,
   warnIfIndexerCursorStale,
} from '../indexer-cursor-staleness.utils';
import { logger } from '../logger.utils';
import { prisma } from '../prisma.utils';
import { envConfig } from '../../config';

jest.mock('../logger.utils', () => ({
   logger: { warn: jest.fn() },
}));

jest.mock('../prisma.utils', () => ({
   prisma: {
      indexedLedger: {
         findFirst: jest.fn(),
      },
   },
}));

jest.mock('../../config', () => ({
   envConfig: {
      ENABLE_INDEXER_CURSOR_STALENESS_WARNING: true,
      INDEXER_CURSOR_STALE_AGE_WARNING_MS: 300_000,
   },
}));

const warnMock = logger.warn as jest.Mock;
const findFirstMock = prisma.indexedLedger.findFirst as jest.Mock;

beforeEach(() => {
   warnMock.mockClear();
   findFirstMock.mockReset();
   (envConfig as { ENABLE_INDEXER_CURSOR_STALENESS_WARNING: boolean }).ENABLE_INDEXER_CURSOR_STALENESS_WARNING = true;
});

describe('warnIfIndexerCursorStale()', () => {
   it('emits a warning when cursor lag exceeds the threshold', () => {
      const sixMinutesAgo = new Date(Date.now() - 360_000);
      warnIfIndexerCursorStale(sixMinutesAgo, 300_000, {
         job: 'indexer',
         cursor: 'cursor-1',
         ledger: 42,
      });
      expect(warnMock).toHaveBeenCalledTimes(1);
      expect(warnMock).toHaveBeenCalledWith(
         expect.objectContaining({
            msg: 'Indexer cursor lag exceeded threshold',
            job: 'indexer',
            cursor: 'cursor-1',
            ledger: 42,
            lagMs: expect.any(Number),
            thresholdMs: 300_000,
         })
      );
   });

   it('does not emit a warning when cursor lag is within the threshold', () => {
      const oneMinuteAgo = new Date(Date.now() - 60_000);
      warnIfIndexerCursorStale(oneMinuteAgo, 300_000);
      expect(warnMock).not.toHaveBeenCalled();
   });

   it('does not emit a warning when cursor lag exactly equals the threshold', () => {
      const exactly = new Date(Date.now() - 300_000);
      warnIfIndexerCursorStale(exactly, 300_000);
      expect(warnMock).not.toHaveBeenCalled();
   });

   it('includes lastUpdatedAt, lagMs and thresholdMs in the warning payload', () => {
      const ts = new Date(Date.now() - 400_000);
      warnIfIndexerCursorStale(ts, 300_000);
      const call = warnMock.mock.calls[0][0];
      expect(call.lastUpdatedAt).toBe(ts.toISOString());
      expect(typeof call.lagMs).toBe('number');
      expect(call.lagMs).toBeGreaterThan(300_000);
      expect(call.thresholdMs).toBe(300_000);
   });

   it('respects a custom threshold override', () => {
      const twoSecondsAgo = new Date(Date.now() - 2_000);
      warnIfIndexerCursorStale(twoSecondsAgo, 1_000);
      expect(warnMock).toHaveBeenCalledTimes(1);
   });

   it('does not emit a warning when ENABLE_INDEXER_CURSOR_STALENESS_WARNING is false', () => {
      (envConfig as { ENABLE_INDEXER_CURSOR_STALENESS_WARNING: boolean }).ENABLE_INDEXER_CURSOR_STALENESS_WARNING = false;
      const sixMinutesAgo = new Date(Date.now() - 360_000);
      warnIfIndexerCursorStale(sixMinutesAgo, 300_000);
      expect(warnMock).not.toHaveBeenCalled();
   });
});

describe('checkIndexerCursorStalenessFromStore()', () => {
   it('emits a warning when the stored cursor is stale', async () => {
      findFirstMock.mockResolvedValue({
         ledger: 99,
         cursor: 'abc',
         updatedAt: new Date(Date.now() - 400_000),
      });

      await checkIndexerCursorStalenessFromStore({ job: 'indexer' });

      expect(warnMock).toHaveBeenCalledWith(
         expect.objectContaining({
            job: 'indexer',
            cursor: 'abc',
            ledger: 99,
            lagMs: expect.any(Number),
            thresholdMs: 300_000,
         })
      );
   });

   it('does not emit a warning when no indexed ledger row exists', async () => {
      findFirstMock.mockResolvedValue(null);

      await checkIndexerCursorStalenessFromStore();

      expect(warnMock).not.toHaveBeenCalled();
   });

   it('does not emit a warning when the stored cursor is fresh', async () => {
      findFirstMock.mockResolvedValue({
         ledger: 1,
         cursor: 'fresh',
         updatedAt: new Date(),
      });

      await checkIndexerCursorStalenessFromStore();

      expect(warnMock).not.toHaveBeenCalled();
   });
});
