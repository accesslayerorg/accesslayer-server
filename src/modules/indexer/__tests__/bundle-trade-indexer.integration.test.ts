import {
   processBundleTradeEvent,
   processBundleTradeEvents,
   BundleExecutedEvent,
   normalizeBundleEvent,
} from '../bundle-trade-indexer.service';
import { logger } from '../../../utils/logger.utils';

jest.setTimeout(30000);

function makeMockBundleDb() {
   const store = new Map<string, any>();

   return {
      store,
      bundleTrade: {
         findFirst: jest.fn(
            async ({
               where,
            }: {
               where: { OR: Array<{ ledger?: number; txHash?: string }> };
            }) => {
               for (const cond of where.OR) {
                  if (cond.ledger && cond.txHash) {
                     const key = `${cond.ledger}:${cond.txHash}`;
                     if (store.has(key)) return store.get(key);
                  } else if (cond.txHash) {
                     for (const record of store.values()) {
                        if (record.txHash === cond.txHash) return record;
                     }
                  }
               }
               return null;
            }
         ),
         findUnique: jest.fn(
            async ({
               where,
            }: {
               where: { ledger_txHash: { ledger: number; txHash: string } };
            }) => {
               const key = `${where.ledger_txHash.ledger}:${where.ledger_txHash.txHash}`;
               return store.has(key) ? store.get(key) : null;
            }
         ),
         create: jest.fn(async ({ data }: { data: any }) => {
            const key = `${data.ledger}:${data.txHash}`;
            if (store.has(key)) {
               const error: any = new Error(
                  'Unique constraint failed on the fields: (`ledger`,`tx_hash`)'
               );
               error.code = 'P2002';
               throw error;
            }
            const record = {
               id: `bundle-${store.size + 1}`,
               ...data,
               createdAt: new Date(),
            };
            store.set(key, record);
            return record;
         }),
         findMany: jest.fn(async () => Array.from(store.values())),
         count: jest.fn(async () => store.size),
      },
   };
}

describe('Bundle trade indexer for atomic multi-key purchase history', () => {
   let mockDb: ReturnType<typeof makeMockBundleDb>;
   let loggerWarnSpy: jest.SpyInstance;

   beforeEach(() => {
      mockDb = makeMockBundleDb();
      loggerWarnSpy = jest
         .spyOn(logger, 'warn')
         .mockImplementation(() => logger as any);
      jest.spyOn(logger, 'info').mockImplementation(() => logger as any);
   });

   afterEach(() => {
      jest.restoreAllMocks();
   });

   const validBundleEvent: BundleExecutedEvent = {
      buyer: 'GBUYER11111111111111111111111111111111111111111111111111',
      total_cost: '25000',
      item_count: 2,
      items: [
         { key: 'creator-alpha', amount: 10, price: '1000' },
         { key: 'creator-beta', amount: 5, price: '3000' },
      ],
      ledger: 5001,
      tx_hash: '0xbundle123hash',
      timestamp: '2026-10-18T10:00:00.000Z',
   };

   describe('AC 1 & 5: Indexing BundleExecuted events with full per-item breakdown', () => {
      it('creates a bundle trade record with header and per-item breakdown in bundle_trades table', async () => {
         const processed = await processBundleTradeEvent(
            validBundleEvent,
            mockDb as any
         );

         expect(processed).toBe(true);
         expect(mockDb.bundleTrade.create).toHaveBeenCalledTimes(1);

         const records = await mockDb.bundleTrade.findMany();
         expect(records).toHaveLength(1);

         const record = records[0];
         expect(record.wallet).toBe(
            'GBUYER11111111111111111111111111111111111111111111111111'
         );
         expect(record.buyer).toBe(
            'GBUYER11111111111111111111111111111111111111111111111111'
         );
         expect(record.totalCost).toBe('25000');
         expect(record.itemCount).toBe(2);
         expect(record.ledger).toBe(5001);
         expect(record.txHash).toBe('0xbundle123hash');
         expect(record.timestamp).toEqual(new Date('2026-10-18T10:00:00.000Z'));

         // Verify per-item data accurately reflects contract event breakdown
         expect(record.items).toHaveLength(2);
         expect(record.items[0]).toEqual({
            key: 'creator-alpha',
            creatorId: 'creator-alpha',
            creator_id: 'creator-alpha',
            amount: 10,
            quantity: 10,
            price: '1000',
         });
         expect(record.items[1]).toEqual({
            key: 'creator-beta',
            creatorId: 'creator-beta',
            creator_id: 'creator-beta',
            amount: 5,
            quantity: 5,
            price: '3000',
         });
      });

      it('normalizes alternative field names (e.g. legs, creator, quantity, occurredAt, txHash)', async () => {
         const altEvent: BundleExecutedEvent = {
            wallet: 'GBUYER22222222222222222222222222222222222222222222222222',
            totalCost: '15000',
            itemCount: 1,
            legs: [
               { creator: 'creator-gamma', quantity: 3, price: '5000' } as any,
            ],
            ledger: 5002,
            txHash: '0xalt123hash',
            occurredAt: '2026-10-18T10:05:00.000Z',
         };

         const processed = await processBundleTradeEvent(
            altEvent,
            mockDb as any
         );
         expect(processed).toBe(true);

         const records = await mockDb.bundleTrade.findMany();
         expect(records).toHaveLength(1);
         expect(records[0].wallet).toBe(
            'GBUYER22222222222222222222222222222222222222222222222222'
         );
         expect(records[0].items[0].key).toBe('creator-gamma');
         expect(records[0].items[0].amount).toBe(3);
         expect(records[0].items[0].price).toBe('5000');
      });

      it('auto-computes totalCost and itemCount when omitted from event payload', async () => {
         const eventWithoutTotals: BundleExecutedEvent = {
            buyer: 'GBUYER33333333333333333333333333333333333333333333333333',
            items: [
               { key: 'creator-1', amount: 2, price: '1000' },
               { key: 'creator-2', amount: 3, price: '2000' },
            ],
            ledger: 5003,
            tx_hash: '0xautocompute123',
            timestamp: '2026-10-18T10:10:00.000Z',
         };

         const processed = await processBundleTradeEvent(
            eventWithoutTotals,
            mockDb as any
         );
         expect(processed).toBe(true);

         const records = await mockDb.bundleTrade.findMany();
         expect(records).toHaveLength(1);
         // (2 * 1000) + (3 * 2000) = 8000
         expect(records[0].totalCost).toBe('8000');
         expect(records[0].itemCount).toBe(2);
      });
   });

   describe('AC 4: Deduplication guard on reindex', () => {
      it('prevents duplicate bundle records on indexer reindex (database lookup)', async () => {
         // First index run
         const firstRun = await processBundleTradeEvent(
            validBundleEvent,
            mockDb as any
         );
         expect(firstRun).toBe(true);
         expect(mockDb.bundleTrade.create).toHaveBeenCalledTimes(1);

         // Second index run (reindex / replay)
         const secondRun = await processBundleTradeEvent(
            validBundleEvent,
            mockDb as any
         );
         expect(secondRun).toBe(false);

         // Database create should NOT be called a second time
         expect(mockDb.bundleTrade.create).toHaveBeenCalledTimes(1);
         const records = await mockDb.bundleTrade.findMany();
         expect(records).toHaveLength(1);
      });

      it('skips duplicate events via in-memory seen Set during batch processing', async () => {
         const seen = new Set<string>();
         const eventWithIndex: BundleExecutedEvent = {
            ...validBundleEvent,
            eventIndex: 0,
         };

         const first = await processBundleTradeEvent(
            eventWithIndex,
            mockDb as any,
            seen
         );
         expect(first).toBe(true);

         const second = await processBundleTradeEvent(
            eventWithIndex,
            mockDb as any,
            seen
         );
         expect(second).toBe(false);

         expect(mockDb.bundleTrade.create).toHaveBeenCalledTimes(1);
      });

      it('safely handles unique constraint violations (P2002) as duplicate skips', async () => {
         // Force mockDb to throw unique constraint error directly on create
         mockDb.bundleTrade.findFirst.mockResolvedValueOnce(null); // Simulate race condition
         mockDb.bundleTrade.create.mockRejectedValueOnce({
            code: 'P2002',
            message: 'Unique constraint failed',
         });

         const result = await processBundleTradeEvent(
            validBundleEvent,
            mockDb as any
         );
         expect(result).toBe(false);
      });

      it('batch processing with processBundleTradeEvents dedupes and counts processed/skipped accurately', async () => {
         const batch = [
            validBundleEvent,
            validBundleEvent, // duplicate
            {
               ...validBundleEvent,
               ledger: 5002,
               tx_hash: '0xanotherbundle',
            },
         ];

         const { processed, skipped } = await processBundleTradeEvents(
            batch,
            mockDb as any
         );
         expect(processed).toBe(2);
         expect(skipped).toBe(1);

         const records = await mockDb.bundleTrade.findMany();
         expect(records).toHaveLength(2);
      });
   });

   describe('Error handling & validation of malformed events', () => {
      it('skips an event missing wallet/buyer with a warn log', async () => {
         const malformed: Partial<BundleExecutedEvent> = {
            // missing buyer/wallet
            total_cost: '10000',
            items: [{ key: 'k1', amount: 1, price: '10000' }],
            ledger: 6001,
            tx_hash: '0xhash1',
            timestamp: '2026-10-18T11:00:00.000Z',
         };

         const result = await processBundleTradeEvent(malformed, mockDb as any);
         expect(result).toBe(false);
         expect(mockDb.bundleTrade.create).not.toHaveBeenCalled();
         expect(loggerWarnSpy).toHaveBeenCalledWith(
            expect.objectContaining({
               type: 'bundle_event_skipped',
               missing_fields: expect.arrayContaining(['wallet']),
            }),
            'Skipping bundle trade event with missing required fields'
         );
      });

      it('skips an event with empty or missing items array with a warn log', async () => {
         const emptyItems: Partial<BundleExecutedEvent> = {
            buyer: 'GBUYER11111111111111111111111111111111111111111111111111',
            items: [], // empty
            ledger: 6002,
            tx_hash: '0xhash2',
            timestamp: '2026-10-18T11:00:00.000Z',
         };

         const result = await processBundleTradeEvent(
            emptyItems,
            mockDb as any
         );
         expect(result).toBe(false);
         expect(mockDb.bundleTrade.create).not.toHaveBeenCalled();
         expect(loggerWarnSpy).toHaveBeenCalled();
      });

      it('skips an event with invalid timestamp', async () => {
         const invalidDate: Partial<BundleExecutedEvent> = {
            buyer: 'GBUYER11111111111111111111111111111111111111111111111111',
            items: [{ key: 'k1', amount: 1, price: '1000' }],
            ledger: 6003,
            tx_hash: '0xhash3',
            timestamp: 'not-a-valid-date',
         };

         const result = await processBundleTradeEvent(
            invalidDate,
            mockDb as any
         );
         expect(result).toBe(false);
         expect(mockDb.bundleTrade.create).not.toHaveBeenCalled();
      });

      it('normalizeBundleEvent returns null on completely invalid payload', () => {
         expect(normalizeBundleEvent({})).toBeNull();
         expect(normalizeBundleEvent({ buyer: 'G1', ledger: NaN })).toBeNull();
      });
   });
});
