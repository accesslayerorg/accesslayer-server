/* In-memory stand-in for the Dutch auction tables so replay behaviour is real. */
type Auction = Record<string, any>;
type Fill = Record<string, any>;

const store = {
   auctions: new Map<string, Auction>(),
   fills: new Map<string, Fill>(),
};

function matches(row: Auction, where: any): boolean {
   return Object.entries(where).every(([key, cond]) => {
      if (cond && typeof cond === 'object' && 'in' in (cond as object)) {
         return (cond as any).in.includes(row[key]);
      }
      return row[key] === cond;
   });
}

const prismaMock: any = {
   dutchAuction: {
      upsert: jest.fn(async ({ where, create }: any) => {
         if (!store.auctions.has(where.id)) {
            store.auctions.set(where.id, {
               fillCount: 0,
               ...create,
            });
         }
      }),
      findUnique: jest.fn(async ({ where }: any) => {
         const row = store.auctions.get(where.id);
         return row ? { ...row } : null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
         const row = store.auctions.get(where.id)!;
         const next = { ...row };
         for (const [key, value] of Object.entries(data)) {
            next[key] =
               value &&
               typeof value === 'object' &&
               'increment' in (value as object)
                  ? row[key] + (value as any).increment
                  : value;
         }
         store.auctions.set(where.id, next);
         return next;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
         let count = 0;
         for (const [id, row] of store.auctions) {
            if (matches(row, where)) {
               store.auctions.set(id, { ...row, ...data });
               count += 1;
            }
         }
         return { count };
      }),
   },
   dutchAuctionFill: {
      createMany: jest.fn(async ({ data }: any) => {
         let count = 0;
         for (const fill of data) {
            const key = `${fill.txHash}:${fill.eventIndex}`;
            if (!store.fills.has(key)) {
               store.fills.set(key, fill);
               count += 1;
            }
         }
         return { count };
      }),
   },
   $transaction: jest.fn(async (fn: any) => fn(prismaMock)),
};

jest.mock('../../utils/prisma.utils', () => ({ prisma: prismaMock }));
jest.mock('../../utils/logger.utils', () => ({
   logger: {
      error: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
   },
}));

import {
   DUTCH_AUCTION_EVENT_TYPES,
   processDutchAuctionEvents,
} from './dutch-auction-indexer.service';
import { IndexerChainEvent } from '../../utils/indexer-event-processor.utils';

const started = (
   overrides: Partial<IndexerChainEvent> = {}
): IndexerChainEvent => ({
   eventType: 'auction_started',
   txHash: 'tx-start',
   eventIndex: 0,
   ledger: 1000,
   auctionId: 'a1',
   seller: 'GSELLER',
   keyId: 'key-1',
   quantity: 10,
   startPrice: '100',
   floorPrice: '10',
   durationLedgers: 100,
   ...overrides,
});

const filled = (
   txHash: string,
   quantity: number,
   overrides: Partial<IndexerChainEvent> = {}
): IndexerChainEvent => ({
   eventType: 'auction_filled',
   txHash,
   eventIndex: 0,
   ledger: 1010,
   auctionId: 'a1',
   buyer: 'GBUYER',
   quantity,
   ...overrides,
});

const cancelled = (txHash = 'tx-cancel'): IndexerChainEvent => ({
   eventType: 'auction_cancelled',
   txHash,
   eventIndex: 0,
   ledger: 1020,
   auctionId: 'a1',
});

describe('Dutch auction indexer', () => {
   beforeEach(() => {
      store.auctions.clear();
      store.fills.clear();
      jest.clearAllMocks();
   });

   it('registers the three event types', () => {
      expect([...DUTCH_AUCTION_EVENT_TYPES]).toEqual(
         expect.arrayContaining([
            'auction_started',
            'auction_filled',
            'auction_cancelled',
         ])
      );
   });

   it('creates an open auction on auction_started', async () => {
      await processDutchAuctionEvents([started()]);

      expect(store.auctions.get('a1')).toMatchObject({
         id: 'a1',
         seller: 'GSELLER',
         keyId: 'key-1',
         quantity: 10,
         remaining: 10,
         startPrice: '100',
         floorPrice: '10',
         startLedger: 1000,
         durationLedgers: 100,
         status: 'open',
         fillCount: 0,
      });
   });

   it('falls back to the event ledger when startLedger is not provided', async () => {
      await processDutchAuctionEvents([started({ ledger: 4321 })]);
      expect(store.auctions.get('a1')?.startLedger).toBe(4321);
   });

   it('keeps the auction open and reduces remaining on a partial fill', async () => {
      await processDutchAuctionEvents([started(), filled('tx-f1', 4)]);

      expect(store.auctions.get('a1')).toMatchObject({
         remaining: 6,
         status: 'open',
         fillCount: 1,
      });
   });

   it('applies successive partial fills and completes when exhausted', async () => {
      await processDutchAuctionEvents([
         started(),
         filled('tx-f1', 4),
         filled('tx-f2', 6),
      ]);

      expect(store.auctions.get('a1')).toMatchObject({
         remaining: 0,
         status: 'filled',
         fillCount: 2,
      });
   });

   it('never lets remaining go negative', async () => {
      await processDutchAuctionEvents([started(), filled('tx-f1', 99)]);
      expect(store.auctions.get('a1')).toMatchObject({
         remaining: 0,
         status: 'filled',
      });
   });

   it('does not duplicate state when events are replayed', async () => {
      const events = [started(), filled('tx-f1', 4), cancelled()];
      await processDutchAuctionEvents(events);
      const afterFirst = { ...store.auctions.get('a1') };
      const fillRowsAfterFirst = store.fills.size;

      // Replay the identical batch twice, in separate batches.
      await processDutchAuctionEvents(events);
      await processDutchAuctionEvents(events);

      expect(store.auctions.get('a1')).toEqual(afterFirst);
      expect(store.fills.size).toBe(fillRowsAfterFirst);
      expect(store.auctions.get('a1')).toMatchObject({
         remaining: 6,
         fillCount: 1,
         status: 'cancelled',
      });
   });

   it('ignores a replayed start that arrives after fills', async () => {
      await processDutchAuctionEvents([started(), filled('tx-f1', 4)]);
      await processDutchAuctionEvents([started()]);
      expect(store.auctions.get('a1')).toMatchObject({
         remaining: 6,
         fillCount: 1,
      });
   });

   it('does not apply the same fill twice within one batch', async () => {
      await processDutchAuctionEvents([
         started(),
         filled('tx-f1', 4),
         filled('tx-f1', 4),
      ]);
      expect(store.auctions.get('a1')?.remaining).toBe(6);
   });

   it('cancels an open auction', async () => {
      await processDutchAuctionEvents([started(), cancelled()]);
      expect(store.auctions.get('a1')?.status).toBe('cancelled');
   });

   it('cancels an ended auction but leaves a filled one alone', async () => {
      await processDutchAuctionEvents([started()]);
      store.auctions.set('a1', {
         ...store.auctions.get('a1'),
         status: 'ended',
      });
      await processDutchAuctionEvents([cancelled('tx-c1')]);
      expect(store.auctions.get('a1')?.status).toBe('cancelled');

      store.auctions.clear();
      await processDutchAuctionEvents([
         started(),
         filled('tx-f1', 10),
         cancelled('tx-c2'),
      ]);
      expect(store.auctions.get('a1')?.status).toBe('filled');
   });

   it('reopens an auction marked ended when a fill is observed', async () => {
      await processDutchAuctionEvents([started()]);
      store.auctions.set('a1', {
         ...store.auctions.get('a1'),
         status: 'ended',
      });
      await processDutchAuctionEvents([filled('tx-f1', 3)]);
      expect(store.auctions.get('a1')).toMatchObject({
         status: 'open',
         remaining: 7,
         fillCount: 1,
      });
   });

   it('records but does not apply a fill for a cancelled auction', async () => {
      await processDutchAuctionEvents([
         started(),
         cancelled(),
         filled('tx-f1', 3),
      ]);
      expect(store.auctions.get('a1')).toMatchObject({
         status: 'cancelled',
         remaining: 10,
         fillCount: 0,
      });
   });

   it('rejects a fill for an unknown auction', async () => {
      await expect(
         processDutchAuctionEvents([
            filled('tx-f1', 1, { auctionId: 'missing' }),
         ])
      ).rejects.toThrow('unknown auction missing');
   });

   it.each([
      ['missing seller', { seller: undefined }],
      ['zero quantity', { quantity: 0 }],
      ['non-integer quantity', { quantity: 1.5 }],
      ['floor above start', { floorPrice: '200' }],
      ['bad price', { startPrice: 'abc' }],
      ['zero duration', { durationLedgers: 0 }],
   ])('rejects an invalid start event: %s', async (_name, overrides) => {
      await expect(
         processDutchAuctionEvents([started(overrides as any)])
      ).rejects.toThrow(/Invalid auction_started/);
      expect(store.auctions.size).toBe(0);
   });

   it('ignores unrelated event types', async () => {
      await processDutchAuctionEvents([
         { eventType: 'KEY_BOUGHT', txHash: 'x', eventIndex: 0 },
      ]);
      expect(prismaMock.dutchAuction.upsert).not.toHaveBeenCalled();
   });
});
