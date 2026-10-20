jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      keyDepth: { updateMany: jest.fn(), create: jest.fn() },
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
   parseDepthUpdatedEvent,
   processDepthUpdatedEvent,
   processDepthUpdatedEvents,
   KEY_DEPTH_INDEXER_DLQ_JOB_TYPE,
} from './key-depth-indexer.service';
import { prisma } from '../../utils/prisma.utils';
import { cacheInvalidate } from '../../utils/redis.utils';
import { moveToDLQ } from '../../utils/indexer-dlq.utils';
import { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';

const mockUpdateMany = (prisma as any).keyDepth.updateMany as jest.Mock;
const mockCreate = (prisma as any).keyDepth.create as jest.Mock;
const mockInvalidate = cacheInvalidate as jest.Mock;
const mockDlq = moveToDLQ as jest.Mock;

function depthEvent(
   overrides: Record<string, unknown> = {}
): IndexerChainEvent {
   return {
      txHash: 'tx-1',
      eventIndex: 0,
      eventType: 'DEPTH_UPDATED',
      ledger: 1000,
      creatorId: 'key-1',
      side: 'bid',
      price: '100',
      volume: '50',
      ...overrides,
   };
}

beforeEach(() => {
   jest.clearAllMocks();
   mockUpdateMany.mockResolvedValue({ count: 0 });
   mockCreate.mockResolvedValue({});
});

describe('parseDepthUpdatedEvent', () => {
   it('parses a well-formed event', () => {
      expect(parseDepthUpdatedEvent(depthEvent())).toEqual({
         ok: true,
         value: {
            creatorId: 'key-1',
            side: 'bid',
            price: 100n,
            volume: 50n,
            ledger: 1000,
            txHash: 'tx-1',
            eventIndex: 0,
         },
      });
   });

   it('accepts zero volume (emptied level) and large values exactly', () => {
      const big = '9007199254740993';
      const zero = parseDepthUpdatedEvent(depthEvent({ volume: 0 }));
      const large = parseDepthUpdatedEvent(depthEvent({ price: big }));
      expect(zero.ok && zero.value.volume).toBe(0n);
      expect(large.ok && large.value.price).toBe(BigInt(big));
   });

   it.each([
      ['missing creatorId', { creatorId: '' }],
      ['bad side', { side: 'buy' }],
      ['zero price', { price: '0' }],
      ['negative volume', { volume: '-1' }],
      ['fractional price', { price: 1.5 }],
      ['non-numeric volume', { volume: 'abc' }],
      ['missing ledger', { ledger: undefined }],
      ['missing txHash', { txHash: '' }],
   ])('rejects %s', (_name, overrides) => {
      expect(parseDepthUpdatedEvent(depthEvent(overrides)).ok).toBe(false);
   });
});

describe('processDepthUpdatedEvent', () => {
   it('creates a new level and invalidates the key cache', async () => {
      await expect(processDepthUpdatedEvent(depthEvent())).resolves.toBe(true);

      expect(mockCreate).toHaveBeenCalledWith({
         data: {
            creatorId: 'key-1',
            side: 'bid',
            price: 100n,
            volume: 50n,
            ledger: 1000,
            eventIndex: 0,
            txHash: 'tx-1',
         },
      });
      expect(mockInvalidate).toHaveBeenCalledWith('depth:key-1:*');
   });

   it('updates an existing level with a newer event without creating', async () => {
      mockUpdateMany.mockResolvedValueOnce({ count: 1 });

      await expect(
         processDepthUpdatedEvent(depthEvent({ volume: '75' }))
      ).resolves.toBe(true);

      expect(mockUpdateMany).toHaveBeenCalledWith({
         where: {
            creatorId: 'key-1',
            side: 'bid',
            price: 100n,
            OR: [
               { ledger: { lt: 1000 } },
               { ledger: 1000, eventIndex: { lt: 0 } },
            ],
         },
         data: { volume: 75n, ledger: 1000, eventIndex: 0, txHash: 'tx-1' },
      });
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockInvalidate).toHaveBeenCalledTimes(1);
   });

   it('skips a stale or duplicate event but still invalidates', async () => {
      mockCreate.mockRejectedValueOnce({ code: 'P2002' });

      await expect(processDepthUpdatedEvent(depthEvent())).resolves.toBe(false);

      expect(mockUpdateMany).toHaveBeenCalledTimes(2);
      expect(mockInvalidate).toHaveBeenCalledWith('depth:key-1:*');
   });

   it('recovers when a concurrent writer created the level first', async () => {
      mockUpdateMany
         .mockResolvedValueOnce({ count: 0 })
         .mockResolvedValueOnce({ count: 1 });
      mockCreate.mockRejectedValueOnce({ code: 'P2002' });

      await expect(processDepthUpdatedEvent(depthEvent())).resolves.toBe(true);
   });

   it('rethrows database errors so the cursor does not advance', async () => {
      mockCreate.mockRejectedValueOnce(new Error('db down'));

      await expect(processDepthUpdatedEvent(depthEvent())).rejects.toThrow(
         'db down'
      );
      expect(mockInvalidate).not.toHaveBeenCalled();
   });

   it('sends a malformed event to the DLQ without touching the table', async () => {
      await expect(
         processDepthUpdatedEvent(depthEvent({ side: 'nope' }))
      ).resolves.toBe(false);

      expect(mockDlq).toHaveBeenCalledWith(
         expect.objectContaining({
            jobType: KEY_DEPTH_INDEXER_DLQ_JOB_TYPE,
            retryCount: 0,
         })
      );
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockInvalidate).not.toHaveBeenCalled();
   });
});

describe('processDepthUpdatedEvents', () => {
   it('processes only DepthUpdated events, accepting both spellings', async () => {
      await processDepthUpdatedEvents([
         depthEvent({ txHash: 'a', eventType: 'DepthUpdated' }),
         depthEvent({ txHash: 'b', eventType: 'TRADE_EXECUTED' }),
         depthEvent({ txHash: 'c', side: 'ask', price: '110' }),
      ]);

      expect(mockCreate).toHaveBeenCalledTimes(2);
   });
});
