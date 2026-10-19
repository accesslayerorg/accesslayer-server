jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      twapSnapshot: { create: jest.fn() },
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
   parseTwapUpdatedEvent,
   processTwapUpdatedEvent,
   processTwapUpdatedEvents,
   TWAP_INDEXER_DLQ_JOB_TYPE,
} from './twap-indexer.service';
import { prisma } from '../../utils/prisma.utils';
import { cacheInvalidate } from '../../utils/redis.utils';
import { moveToDLQ } from '../../utils/indexer-dlq.utils';
import { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';

const mockCreate = (prisma as any).twapSnapshot.create as jest.Mock;
const mockInvalidate = cacheInvalidate as jest.Mock;
const mockDlq = moveToDLQ as jest.Mock;

function twapEvent(overrides: Record<string, unknown> = {}): IndexerChainEvent {
   return {
      txHash: 'tx-1',
      eventIndex: 0,
      eventType: 'TWAP_UPDATED',
      ledger: 1000,
      creatorId: 'key-1',
      window: '1h',
      twapPrice: '12500000',
      observationCount: 5,
      computedAt: '2026-10-18T10:00:00.000Z',
      ...overrides,
   };
}

describe('parseTwapUpdatedEvent', () => {
   it('parses a well-formed event', () => {
      const result = parseTwapUpdatedEvent(twapEvent());
      expect(result).toEqual({
         ok: true,
         value: {
            creatorId: 'key-1',
            window: '1h',
            twapPrice: 12500000n,
            observationCount: 5,
            computedAt: new Date('2026-10-18T10:00:00.000Z'),
            ledger: 1000,
            txHash: 'tx-1',
            eventIndex: 0,
         },
      });
   });

   it('accepts bigint, number and string prices without precision loss', () => {
      const big = '9007199254740993'; // > Number.MAX_SAFE_INTEGER
      const fromString = parseTwapUpdatedEvent(twapEvent({ twapPrice: big }));
      const fromBigint = parseTwapUpdatedEvent(
         twapEvent({ twapPrice: BigInt(big) })
      );
      const fromNumber = parseTwapUpdatedEvent(twapEvent({ twapPrice: 42 }));
      expect(fromString.ok && fromString.value.twapPrice).toBe(BigInt(big));
      expect(fromBigint.ok && fromBigint.value.twapPrice).toBe(BigInt(big));
      expect(fromNumber.ok && fromNumber.value.twapPrice).toBe(42n);
   });

   it('reads computedAt as ISO, epoch seconds or epoch milliseconds', () => {
      const iso = '2026-10-18T10:00:00.000Z';
      const ms = Date.parse(iso);
      for (const value of [iso, ms, ms / 1000, String(ms / 1000)]) {
         const result = parseTwapUpdatedEvent(twapEvent({ computedAt: value }));
         expect(result.ok && result.value.computedAt.toISOString()).toBe(iso);
      }
   });

   it.each([
      ['missing creatorId', { creatorId: undefined }],
      ['empty creatorId', { creatorId: '  ' }],
      ['unsupported window', { window: '7d' }],
      ['missing window', { window: undefined }],
      ['negative price', { twapPrice: '-1' }],
      ['fractional price', { twapPrice: 1.5 }],
      ['non-numeric price', { twapPrice: 'abc' }],
      ['missing price', { twapPrice: undefined }],
      ['negative observationCount', { observationCount: -1 }],
      ['fractional observationCount', { observationCount: 2.5 }],
      ['missing observationCount', { observationCount: undefined }],
      ['bad computedAt', { computedAt: 'not-a-date' }],
      ['missing computedAt', { computedAt: undefined }],
      ['missing ledger', { ledger: undefined }],
   ])('rejects %s', (_label, overrides) => {
      expect(parseTwapUpdatedEvent(twapEvent(overrides)).ok).toBe(false);
   });

   it('accepts an observationCount of zero (stored, later reported invalid)', () => {
      expect(parseTwapUpdatedEvent(twapEvent({ observationCount: 0 })).ok).toBe(
         true
      );
   });
});

describe('processTwapUpdatedEvent', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockCreate.mockResolvedValue({});
   });

   it('writes one twap_snapshots row with the event fields', async () => {
      await expect(processTwapUpdatedEvent(twapEvent())).resolves.toBe(true);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockCreate).toHaveBeenCalledWith({
         data: {
            creatorId: 'key-1',
            window: '1h',
            twapPrice: 12500000n,
            observationCount: 5,
            computedAt: new Date('2026-10-18T10:00:00.000Z'),
            ledger: 1000,
            txHash: 'tx-1',
            eventIndex: 0,
         },
      });
   });

   it('invalidates all three windows for the affected key only', async () => {
      await processTwapUpdatedEvent(twapEvent({ creatorId: 'key-1' }));

      expect(mockInvalidate).toHaveBeenCalledTimes(1);
      expect(mockInvalidate).toHaveBeenCalledWith(
         'twap:snapshot:key-1:1h',
         'twap:snapshot:key-1:4h',
         'twap:snapshot:key-1:24h'
      );
      const args = mockInvalidate.mock.calls[0] as string[];
      expect(args.some(k => k.includes('key-2'))).toBe(false);
   });

   it('invalidates after the row is written, not before', async () => {
      const order: string[] = [];
      mockCreate.mockImplementation(async () => {
         order.push('insert');
      });
      mockInvalidate.mockImplementation(async () => {
         order.push('invalidate');
      });

      await processTwapUpdatedEvent(twapEvent());
      expect(order).toEqual(['insert', 'invalidate']);
   });

   it('treats a duplicate (P2002) as a no-op but still invalidates', async () => {
      mockCreate.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }));

      await expect(processTwapUpdatedEvent(twapEvent())).resolves.toBe(false);
      // Covers a crash between the original insert and its invalidation.
      expect(mockInvalidate).toHaveBeenCalledTimes(1);
      expect(mockDlq).not.toHaveBeenCalled();
   });

   it('rethrows other database errors so the cursor cannot advance', async () => {
      mockCreate.mockRejectedValue(new Error('connection lost'));

      await expect(processTwapUpdatedEvent(twapEvent())).rejects.toThrow(
         'connection lost'
      );
      expect(mockInvalidate).not.toHaveBeenCalled();
   });

   it('sends malformed events to the DLQ instead of dropping them silently', async () => {
      await expect(
         processTwapUpdatedEvent(twapEvent({ window: '7d', twapPrice: 5n }))
      ).resolves.toBe(false);

      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockInvalidate).not.toHaveBeenCalled();
      expect(mockDlq).toHaveBeenCalledTimes(1);
      const arg = mockDlq.mock.calls[0][0];
      expect(arg.jobType).toBe(TWAP_INDEXER_DLQ_JOB_TYPE);
      expect(arg.failureReason).toMatch(/window/);
      // bigint in the payload must be JSON-safe
      expect(arg.payload.twapPrice).toBe('5');
   });

   it('fails the batch if the DLQ write itself fails', async () => {
      mockDlq.mockRejectedValueOnce(new Error('dlq down'));
      await expect(
         processTwapUpdatedEvent(twapEvent({ window: 'bogus' }))
      ).rejects.toThrow('dlq down');
   });
});

describe('processTwapUpdatedEvents (batch, no gaps)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockCreate.mockResolvedValue({});
   });

   it('stores every distinct event, including out-of-order ledgers', async () => {
      await processTwapUpdatedEvents([
         twapEvent({ txHash: 'a', ledger: 10 }),
         twapEvent({ txHash: 'c', ledger: 12 }),
         twapEvent({ txHash: 'b', ledger: 11 }),
      ]);

      const stored = mockCreate.mock.calls.map(c => c[0].data.ledger).sort();
      expect(stored).toEqual([10, 11, 12]);
   });

   it('stores multiple events from one transaction (distinct eventIndex)', async () => {
      await processTwapUpdatedEvents([
         twapEvent({ txHash: 'a', eventIndex: 0, window: '1h' }),
         twapEvent({ txHash: 'a', eventIndex: 1, window: '4h' }),
         twapEvent({ txHash: 'a', eventIndex: 2, window: '24h' }),
      ]);
      expect(mockCreate).toHaveBeenCalledTimes(3);
   });

   it('collapses an event delivered twice in one batch', async () => {
      await processTwapUpdatedEvents([twapEvent(), twapEvent()]);
      expect(mockCreate).toHaveBeenCalledTimes(1);
   });

   it('accepts both TWAP_UPDATED and TWAPUpdated and ignores other types', async () => {
      await processTwapUpdatedEvents([
         twapEvent({ txHash: 'a', eventType: 'TWAP_UPDATED' }),
         twapEvent({ txHash: 'b', eventType: 'TWAPUpdated' }),
         twapEvent({ txHash: 'c', eventType: 'KEY_BOUGHT' }),
      ]);
      expect(mockCreate).toHaveBeenCalledTimes(2);
   });

   it('replaying the same batch after a restart never errors or double-counts', async () => {
      const batch = [
         twapEvent({ txHash: 'a', ledger: 10 }),
         twapEvent({ txHash: 'b', ledger: 11 }),
      ];
      const seen = new Set<string>();
      mockCreate.mockImplementation(async ({ data }: any) => {
         const key = `${data.txHash}:${data.eventIndex}`;
         if (seen.has(key)) {
            throw Object.assign(new Error('dup'), { code: 'P2002' });
         }
         seen.add(key);
      });

      await processTwapUpdatedEvents(batch);
      await processTwapUpdatedEvents(batch);

      expect(seen.size).toBe(2);
   });
});
