jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      keyLeaderboard: {
         updateMany: jest.fn(),
         create: jest.fn(),
      },
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
      debug: jest.fn(),
      info: jest.fn(),
      error: jest.fn(),
   },
}));

import { prisma } from '../../utils/prisma.utils';
import { cacheInvalidate } from '../../utils/redis.utils';
import { moveToDLQ } from '../../utils/indexer-dlq.utils';
import {
   parseLeaderboardUpdatedEvent,
   processLeaderboardUpdatedEvent,
   processLeaderboardUpdatedEvents,
   KEY_LEADERBOARD_INDEXER_DLQ_JOB_TYPE,
} from './key-leaderboard-indexer.service';
import { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';

const mockTable = (
   prisma as unknown as {
      keyLeaderboard: { updateMany: jest.Mock; create: jest.Mock };
   }
).keyLeaderboard;
const mockInvalidate = cacheInvalidate as jest.Mock;
const mockDlq = moveToDLQ as jest.Mock;

function leaderboardEvent(
   overrides: Record<string, unknown> = {}
): IndexerChainEvent {
   return {
      txHash: 'tx-1',
      eventIndex: 0,
      eventType: 'LeaderboardUpdated',
      ledger: 100,
      creatorId: 'key-1',
      wallet: 'GABC',
      volume: '100000',
      pnl: '-250',
      holdingDays: '12',
      ...overrides,
   };
}

beforeEach(() => {
   jest.clearAllMocks();
   mockTable.updateMany.mockResolvedValue({ count: 0 });
   mockTable.create.mockResolvedValue({});
});

describe('parseLeaderboardUpdatedEvent', () => {
   it('parses exact integer scores and event aliases', () => {
      expect(
         parseLeaderboardUpdatedEvent(
            leaderboardEvent({
               eventType: 'LEADERBOARD_UPDATED',
               key_id: 'key-2',
               creatorId: undefined,
               wallet_address: 'GWALLET',
               wallet: undefined,
               holding_days: '25',
               holdingDays: undefined,
               volume: '9007199254740993',
            })
         )
      ).toEqual({
         ok: true,
         value: {
            creatorId: 'key-2',
            wallet: 'GWALLET',
            volume: 9007199254740993n,
            pnl: -250n,
            holdingDays: 25n,
            ledger: 100,
            eventIndex: 0,
            txHash: 'tx-1',
         },
      });
   });

   it.each([
      ['missing key', { creatorId: '' }],
      ['missing wallet', { wallet: '' }],
      ['negative volume', { volume: '-1' }],
      ['invalid pnl', { pnl: 'unknown' }],
      ['negative holding days', { holdingDays: '-1' }],
      ['missing ledger', { ledger: undefined }],
      ['missing event identity', { txHash: '' }],
   ])('rejects %s', (_name, overrides) => {
      expect(parseLeaderboardUpdatedEvent(leaderboardEvent(overrides)).ok).toBe(
         false
      );
   });
});

describe('processLeaderboardUpdatedEvent', () => {
   it('upserts a new snapshot and invalidates the key cache', async () => {
      await expect(
         processLeaderboardUpdatedEvent(leaderboardEvent())
      ).resolves.toBe(true);

      expect(mockTable.create).toHaveBeenCalledWith({
         data: {
            creatorId: 'key-1',
            wallet: 'GABC',
            volume: 100000n,
            pnl: -250n,
            holdingDays: 12n,
            ledger: 100,
            eventIndex: 0,
            txHash: 'tx-1',
         },
      });
      expect(mockInvalidate).toHaveBeenCalledWith('key:leaderboard:key-1:*');
   });

   it('overwrites only with a newer on-chain position', async () => {
      mockTable.updateMany.mockResolvedValueOnce({ count: 1 });

      await expect(
         processLeaderboardUpdatedEvent(leaderboardEvent({ ledger: 101 }))
      ).resolves.toBe(true);

      expect(mockTable.updateMany).toHaveBeenCalledWith(
         expect.objectContaining({
            where: {
               creatorId: 'key-1',
               wallet: 'GABC',
               OR: [
                  { ledger: { lt: 101 } },
                  { ledger: 101, eventIndex: { lt: 0 } },
               ],
            },
         })
      );
      expect(mockTable.create).not.toHaveBeenCalled();
   });

   it('moves malformed events to the DLQ', async () => {
      await processLeaderboardUpdatedEvent(
         leaderboardEvent({ holdingDays: '-2' })
      );

      expect(mockDlq).toHaveBeenCalledWith(
         expect.objectContaining({
            jobType: KEY_LEADERBOARD_INDEXER_DLQ_JOB_TYPE,
            retryCount: 0,
         })
      );
      expect(mockTable.create).not.toHaveBeenCalled();
      expect(mockInvalidate).not.toHaveBeenCalled();
   });

   it('propagates persistence errors so the pipeline cursor stays put', async () => {
      mockTable.create.mockRejectedValueOnce(new Error('database unavailable'));

      await expect(
         processLeaderboardUpdatedEvent(leaderboardEvent())
      ).rejects.toThrow('database unavailable');
      expect(mockInvalidate).not.toHaveBeenCalled();
   });

   it('processes supported event spellings and ignores unrelated events', async () => {
      await processLeaderboardUpdatedEvents([
         leaderboardEvent({ txHash: 'first' }),
         leaderboardEvent({ txHash: 'ignored', eventType: 'KEY_BOUGHT' }),
         leaderboardEvent({
            txHash: 'second',
            eventType: 'LEADERBOARD_UPDATED',
         }),
      ]);

      expect(mockTable.create).toHaveBeenCalledTimes(2);
   });
});
