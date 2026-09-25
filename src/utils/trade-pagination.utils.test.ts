import {
   queryTradesPage,
   TradeRecord,
   TradeCursorPayload,
} from './trade-pagination.utils';
import { encodeCursor, decodeCursor } from './cursor.utils';

/**
 * Creates a minimal TradeRecord with sensible defaults, allowing overrides.
 */
function makeTrade(overrides: Partial<TradeRecord>): TradeRecord {
   return {
      id: 'trade-1',
      buyer: 'buyer-1',
      creatorId: 'creator-1',
      quantity: '10',
      price: '100',
      ledger: 1000,
      txHash: 'tx-001',
      timestamp: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
   };
}

/**
 * Creates a mock Prisma-like db whose `trade.findMany` simulates Prisma's
 * filtering, sorting, and limiting behaviour against an in-memory record set.
 *
 * This lets us verify that queryTradesPage produces stable, deterministic
 * ordering within a single page without a real database.
 */
function createMockDb(allRecords: TradeRecord[]) {
   return {
      trade: {
         findMany: jest.fn(async (args: any) => {
            let result = [...allRecords];

            // --- Apply where filter ---
            if (args.where) {
               const where = args.where;

               // Filter by creatorId
               if (where.creatorId) {
                  result = result.filter(r => r.creatorId === where.creatorId);
               }

               // Apply OR conditions (cursor-based keyset filtering)
               if (where.OR) {
                  result = result.filter(r =>
                     where.OR.some((cond: any) => {
                        // Condition 1: { ledger: { lt: X } }
                        if (
                           cond.ledger &&
                           typeof cond.ledger === 'object' &&
                           cond.ledger.lt !== undefined
                        ) {
                           return r.ledger < cond.ledger.lt;
                        }
                        // Condition 2: { ledger: X, txHash: { lt: Y } }
                        if (
                           cond.ledger !== undefined &&
                           typeof cond.ledger !== 'object' &&
                           cond.txHash
                        ) {
                           return (
                              r.ledger === cond.ledger &&
                              r.txHash < cond.txHash.lt
                           );
                        }
                        return false;
                     })
                  );
               }
            }

            // --- Apply orderBy ---
            if (args.orderBy) {
               result.sort((a: any, b: any) => {
                  for (const sort of args.orderBy) {
                     const key = Object.keys(sort)[0];
                     const direction = sort[key];
                     if (a[key] < b[key]) return direction === 'desc' ? 1 : -1;
                     if (a[key] > b[key]) return direction === 'desc' ? -1 : 1;
                  }
                  return 0;
               });
            }

            // --- Apply take ---
            if (args.take !== undefined) {
               result = result.slice(0, args.take);
            }

            return result;
         }),
      },
   };
}

const CREATOR_ID = 'creator-1';

describe('queryTradesPage — stable ordering within a single page', () => {
   let mockDb: ReturnType<typeof createMockDb>;

   beforeEach(() => {
      mockDb = createMockDb([]);
   });

   afterEach(() => {
      jest.clearAllMocks();
   });

   describe('orderBy clause', () => {
      it('passes a composite orderBy of ledger desc then txHash desc to findMany', async () => {
         mockDb = createMockDb([]);
         await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         const callArgs = mockDb.trade.findMany.mock.calls[0][0];
         expect(callArgs.orderBy).toEqual([
            { ledger: 'desc' },
            { txHash: 'desc' },
         ]);
      });

      it('always uses the same orderBy regardless of cursor presence', async () => {
         const cursor = encodeCursor<TradeCursorPayload>({
            ledger: 2000,
            tx_hash: 'tx-002',
         });

         // First page (no cursor)
         await queryTradesPage(CREATOR_ID, null, 10, mockDb);
         const firstCallOrderBy =
            mockDb.trade.findMany.mock.calls[0][0].orderBy;

         // Second page (with cursor)
         await queryTradesPage(CREATOR_ID, cursor, 10, mockDb);
         const secondCallOrderBy =
            mockDb.trade.findMany.mock.calls[1][0].orderBy;

         expect(firstCallOrderBy).toEqual(secondCallOrderBy);
         expect(firstCallOrderBy).toEqual([
            { ledger: 'desc' },
            { txHash: 'desc' },
         ]);
      });
   });

   describe('first page ordering', () => {
      it('returns trades ordered by ledger descending', async () => {
         const trades = [
            makeTrade({ id: 't1', ledger: 1000, txHash: 'tx-a' }),
            makeTrade({ id: 't2', ledger: 3000, txHash: 'tx-b' }),
            makeTrade({ id: 't3', ledger: 2000, txHash: 'tx-c' }),
         ];
         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         expect(result.items.map(t => t.ledger)).toEqual([3000, 2000, 1000]);
      });

      it('returns trades ordered by txHash descending when ledgers are equal', async () => {
         const trades = [
            makeTrade({ id: 't1', ledger: 2000, txHash: 'tx-aaa' }),
            makeTrade({ id: 't2', ledger: 2000, txHash: 'tx-zzz' }),
            makeTrade({ id: 't3', ledger: 2000, txHash: 'tx-mmm' }),
         ];
         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         expect(result.items.map(t => t.txHash)).toEqual([
            'tx-zzz',
            'tx-mmm',
            'tx-aaa',
         ]);
      });

      it('uses txHash as a deterministic tiebreaker for same-ledger trades', async () => {
         // Two trades at the same ledger — without a tiebreaker the order
         // would be non-deterministic, but with txHash desc it is stable.
         const trades = [
            makeTrade({ id: 't1', ledger: 5000, txHash: 'tx-001' }),
            makeTrade({ id: 't2', ledger: 5000, txHash: 'tx-002' }),
            makeTrade({ id: 't3', ledger: 5000, txHash: 'tx-003' }),
         ];
         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         // txHash descending: 003, 002, 001
         expect(result.items.map(t => t.txHash)).toEqual([
            'tx-003',
            'tx-002',
            'tx-001',
         ]);
      });

      it('interleaves different ledgers with same-ledger groups correctly', async () => {
         const trades = [
            makeTrade({ id: 't1', ledger: 1000, txHash: 'tx-aaa' }),
            makeTrade({ id: 't2', ledger: 2000, txHash: 'tx-001' }),
            makeTrade({ id: 't3', ledger: 2000, txHash: 'tx-003' }),
            makeTrade({ id: 't4', ledger: 3000, txHash: 'tx-zzz' }),
            makeTrade({ id: 't5', ledger: 2000, txHash: 'tx-002' }),
         ];
         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         // Expected: 3000/zzz, 2000/003, 2000/002, 2000/001, 1000/aaa
         expect(result.items.map(t => `${t.ledger}/${t.txHash}`)).toEqual([
            '3000/tx-zzz',
            '2000/tx-003',
            '2000/tx-002',
            '2000/tx-001',
            '1000/tx-aaa',
         ]);
      });
   });

   describe('deterministic ordering', () => {
      it('produces the same item order on repeated calls with identical data', async () => {
         const trades = [
            makeTrade({ id: 't1', ledger: 1000, txHash: 'tx-a' }),
            makeTrade({ id: 't2', ledger: 2000, txHash: 'tx-b' }),
            makeTrade({ id: 't3', ledger: 2000, txHash: 'tx-c' }),
            makeTrade({ id: 't4', ledger: 3000, txHash: 'tx-d' }),
         ];
         mockDb = createMockDb(trades);

         const result1 = await queryTradesPage(CREATOR_ID, null, 10, mockDb);
         const result2 = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         expect(result1.items.map(t => t.id)).toEqual(
            result2.items.map(t => t.id)
         );
      });

      it('maintains stable ordering even when input array is shuffled', async () => {
         const trades = [
            makeTrade({ id: 't1', ledger: 1000, txHash: 'tx-a' }),
            makeTrade({ id: 't2', ledger: 2000, txHash: 'tx-b' }),
            makeTrade({ id: 't3', ledger: 2000, txHash: 'tx-c' }),
            makeTrade({ id: 't4', ledger: 3000, txHash: 'tx-d' }),
         ];

         // Query with trades in one order
         mockDb = createMockDb([...trades]);
         const result1 = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         // Query with trades in a different (shuffled) order
         mockDb = createMockDb([...trades].reverse());
         const result2 = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         // The output order should be the same regardless of input order
         expect(result1.items.map(t => t.id)).toEqual(
            result2.items.map(t => t.id)
         );
      });
   });

   describe('cursor generation', () => {
      it('encodes the last item ledger and txHash as the next cursor', async () => {
         const trades = [
            makeTrade({ id: 't1', ledger: 3000, txHash: 'tx-003' }),
            makeTrade({ id: 't2', ledger: 2000, txHash: 'tx-002' }),
            makeTrade({ id: 't3', ledger: 1000, txHash: 'tx-001' }),
         ];
         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 2, mockDb);

         expect(result.has_more).toBe(true);
         expect(result.cursor).not.toBeNull();

         const decoded = decodeCursor<TradeCursorPayload>(result.cursor!);
         // The last item on the page is t2 (ledger 2000, txHash tx-002)
         expect(decoded.ledger).toBe(2000);
         expect(decoded.tx_hash).toBe('tx-002');
      });

      it('returns null cursor when there are no more pages', async () => {
         const trades = [
            makeTrade({ id: 't1', ledger: 3000, txHash: 'tx-003' }),
            makeTrade({ id: 't2', ledger: 2000, txHash: 'tx-002' }),
         ];
         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         expect(result.has_more).toBe(false);
         expect(result.cursor).toBeNull();
      });

      it('returns null cursor when results are empty', async () => {
         mockDb = createMockDb([]);

         const result = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         expect(result.items).toEqual([]);
         expect(result.has_more).toBe(false);
         expect(result.cursor).toBeNull();
      });

      it('cursor is decodable and round-trips correctly', async () => {
         const trades = [
            makeTrade({ id: 't1', ledger: 3000, txHash: 'tx-003' }),
            makeTrade({ id: 't2', ledger: 2000, txHash: 'tx-002' }),
            makeTrade({ id: 't3', ledger: 1000, txHash: 'tx-001' }),
         ];
         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 2, mockDb);

         // The cursor should be decodable back to the original payload
         const decoded = decodeCursor<TradeCursorPayload>(result.cursor!);
         expect(decoded).toEqual({
            ledger: 2000,
            tx_hash: 'tx-002',
         });
      });
   });

   describe('cursor-based pagination', () => {
      it('uses cursor to filter out previous page results', async () => {
         const trades = [
            makeTrade({ id: 't1', ledger: 4000, txHash: 'tx-004' }),
            makeTrade({ id: 't2', ledger: 3000, txHash: 'tx-003' }),
            makeTrade({ id: 't3', ledger: 2000, txHash: 'tx-002' }),
            makeTrade({ id: 't4', ledger: 1000, txHash: 'tx-001' }),
         ];
         mockDb = createMockDb(trades);

         // First page: limit 2
         const page1 = await queryTradesPage(CREATOR_ID, null, 2, mockDb);
         expect(page1.items.map(t => t.id)).toEqual(['t1', 't2']);
         expect(page1.has_more).toBe(true);

         // Second page: use cursor from first page
         const page2 = await queryTradesPage(
            CREATOR_ID,
            page1.cursor,
            2,
            mockDb
         );
         expect(page2.items.map(t => t.id)).toEqual(['t3', 't4']);
         expect(page2.has_more).toBe(false);
      });

      it('constructs the correct OR where clause from the cursor', async () => {
         const trades = [
            makeTrade({ id: 't1', ledger: 4000, txHash: 'tx-004' }),
            makeTrade({ id: 't2', ledger: 3000, txHash: 'tx-003' }),
            makeTrade({ id: 't3', ledger: 2000, txHash: 'tx-002' }),
         ];
         mockDb = createMockDb(trades);

         const cursor = encodeCursor<TradeCursorPayload>({
            ledger: 3000,
            tx_hash: 'tx-003',
         });

         await queryTradesPage(CREATOR_ID, cursor, 10, mockDb);

         const callArgs = mockDb.trade.findMany.mock.calls[0][0];
         expect(callArgs.where).toEqual({
            creatorId: CREATOR_ID,
            OR: [
               { ledger: { lt: 3000 } },
               { ledger: 3000, txHash: { lt: 'tx-003' } },
            ],
         });
      });

      it('handles same-ledger cursor correctly (txHash tiebreaker)', async () => {
         const trades = [
            makeTrade({ id: 't1', ledger: 2000, txHash: 'tx-zzz' }),
            makeTrade({ id: 't2', ledger: 2000, txHash: 'tx-yyy' }),
            makeTrade({ id: 't3', ledger: 2000, txHash: 'tx-xxx' }),
            makeTrade({ id: 't4', ledger: 1000, txHash: 'tx-aaa' }),
         ];
         mockDb = createMockDb(trades);

         // First page: limit 2, should return t1 and t2 (both ledger 2000)
         const page1 = await queryTradesPage(CREATOR_ID, null, 2, mockDb);
         expect(page1.items.map(t => t.id)).toEqual(['t1', 't2']);
         expect(page1.has_more).toBe(true);

         // Cursor should encode t2's ledger (2000) and txHash (tx-yyy)
         const decoded = decodeCursor<TradeCursorPayload>(page1.cursor!);
         expect(decoded.ledger).toBe(2000);
         expect(decoded.tx_hash).toBe('tx-yyy');

         // Second page: should return t3 (same ledger, lower txHash) and t4
         const page2 = await queryTradesPage(
            CREATOR_ID,
            page1.cursor,
            2,
            mockDb
         );
         expect(page2.items.map(t => t.id)).toEqual(['t3', 't4']);
         expect(page2.has_more).toBe(false);
      });

      it('does not duplicate items across pages', async () => {
         const trades = Array.from({ length: 10 }, (_, i) =>
            makeTrade({
               id: `t${i}`,
               ledger: 10000 - i * 100,
               txHash: `tx-${String(i).padStart(3, '0')}`,
            })
         );
         mockDb = createMockDb(trades);

         const allIds: string[] = [];
         let cursor: string | null = null;
         let hasMore = true;

         while (hasMore) {
            const result = await queryTradesPage(CREATOR_ID, cursor, 3, mockDb);
            allIds.push(...result.items.map(t => t.id));
            cursor = result.cursor;
            hasMore = result.has_more;
         }

         // No duplicates
         expect(new Set(allIds).size).toBe(allIds.length);
         // All items retrieved
         expect(allIds).toHaveLength(10);
         // Items are in stable order (ledger desc, txHash desc)
         expect(allIds).toEqual([
            't0',
            't1',
            't2',
            't3',
            't4',
            't5',
            't6',
            't7',
            't8',
            't9',
         ]);
      });
   });

   describe('take parameter', () => {
      it('requests limit + 1 records to detect has_more', async () => {
         mockDb = createMockDb([]);
         await queryTradesPage(CREATOR_ID, null, 5, mockDb);

         const callArgs = mockDb.trade.findMany.mock.calls[0][0];
         expect(callArgs.take).toBe(6); // 5 + 1
      });

      it('clamps limit to a minimum of 1', async () => {
         mockDb = createMockDb([]);
         await queryTradesPage(CREATOR_ID, null, 0, mockDb);

         const callArgs = mockDb.trade.findMany.mock.calls[0][0];
         expect(callArgs.take).toBe(2); // max(1, 0) + 1 = 2
      });

      it('clamps negative limit to a minimum of 1', async () => {
         mockDb = createMockDb([]);
         await queryTradesPage(CREATOR_ID, null, -5, mockDb);

         const callArgs = mockDb.trade.findMany.mock.calls[0][0];
         expect(callArgs.take).toBe(2); // max(1, -5) + 1 = 2
      });
   });

   describe('where clause', () => {
      it('filters by creatorId when no cursor is provided', async () => {
         mockDb = createMockDb([]);
         await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         const callArgs = mockDb.trade.findMany.mock.calls[0][0];
         expect(callArgs.where).toEqual({ creatorId: CREATOR_ID });
      });

      it('includes creatorId in the where clause when a cursor is provided', async () => {
         const cursor = encodeCursor<TradeCursorPayload>({
            ledger: 2000,
            tx_hash: 'tx-002',
         });

         mockDb = createMockDb([]);
         await queryTradesPage(CREATOR_ID, cursor, 10, mockDb);

         const callArgs = mockDb.trade.findMany.mock.calls[0][0];
         expect(callArgs.where.creatorId).toBe(CREATOR_ID);
         expect(callArgs.where.OR).toBeDefined();
      });
   });

   describe('has_more detection', () => {
      it('sets has_more to true when results exceed the limit', async () => {
         const trades = Array.from({ length: 5 }, (_, i) =>
            makeTrade({
               id: `t${i}`,
               ledger: 5000 - i * 1000,
               txHash: `tx-${i}`,
            })
         );
         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 3, mockDb);

         expect(result.items).toHaveLength(3);
         expect(result.has_more).toBe(true);
         expect(result.cursor).not.toBeNull();
      });

      it('sets has_more to false when results exactly fill the page', async () => {
         const trades = Array.from({ length: 3 }, (_, i) =>
            makeTrade({
               id: `t${i}`,
               ledger: 3000 - i * 1000,
               txHash: `tx-${i}`,
            })
         );
         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 3, mockDb);

         expect(result.items).toHaveLength(3);
         expect(result.has_more).toBe(false);
         expect(result.cursor).toBeNull();
      });

      it('sets has_more to false when results are fewer than the limit', async () => {
         const trades = [
            makeTrade({ id: 't1', ledger: 3000, txHash: 'tx-001' }),
            makeTrade({ id: 't2', ledger: 2000, txHash: 'tx-002' }),
         ];
         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         expect(result.items).toHaveLength(2);
         expect(result.has_more).toBe(false);
         expect(result.cursor).toBeNull();
      });
   });

   // ---------------------------------------------------------------------------
   // Stable ordering within a single page — additional edge cases
   //
   // These tests focus on the guarantee that a single page of results is
   // deterministically ordered by (ledger DESC, txHash DESC) regardless of
   // input data distribution, page size, or whether the page boundary falls
   // in the middle of a group of records that share the same sort keys.
   // ---------------------------------------------------------------------------
   describe('stable ordering within a single page', () => {
      it('orders a single-item page correctly', async () => {
         const trades = [
            makeTrade({ id: 't1', ledger: 5000, txHash: 'tx-001' }),
         ];
         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 1, mockDb);

         expect(result.items).toHaveLength(1);
         expect(result.items[0].ledger).toBe(5000);
         expect(result.has_more).toBe(false);
      });

      it('orders a single-item page correctly when it is the only record', async () => {
         const trades = [makeTrade({ id: 't1', ledger: 1, txHash: 'tx-001' })];
         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 5, mockDb);

         expect(result.items).toHaveLength(1);
         expect(result.items[0].id).toBe('t1');
         expect(result.has_more).toBe(false);
      });

      it('maintains stable ordering when all items share the same ledger', async () => {
         // Every record has ledger 5000 — ordering must rely entirely on
         // the txHash DESC tiebreaker and be deterministic.
         const trades = [
            makeTrade({ id: 't1', ledger: 5000, txHash: 'tx-aaa' }),
            makeTrade({ id: 't2', ledger: 5000, txHash: 'tx-zzz' }),
            makeTrade({ id: 't3', ledger: 5000, txHash: 'tx-mmm' }),
            makeTrade({ id: 't4', ledger: 5000, txHash: 'tx-bbb' }),
         ];
         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         expect(result.items.map(t => t.txHash)).toEqual([
            'tx-zzz',
            'tx-mmm',
            'tx-bbb',
            'tx-aaa',
         ]);
      });

      it('maintains stable ordering when all items share the same ledger (shuffled input)', async () => {
         const base = [
            makeTrade({ id: 't1', ledger: 5000, txHash: 'tx-aaa' }),
            makeTrade({ id: 't2', ledger: 5000, txHash: 'tx-zzz' }),
            makeTrade({ id: 't3', ledger: 5000, txHash: 'tx-mmm' }),
            makeTrade({ id: 't4', ledger: 5000, txHash: 'tx-bbb' }),
         ];

         // Forward order
         mockDb = createMockDb([...base]);
         const forward = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         // Reverse order
         mockDb = createMockDb([...base].reverse());
         const reverse = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         expect(forward.items.map(t => t.txHash)).toEqual(
            reverse.items.map(t => t.txHash)
         );
         expect(forward.items.map(t => t.txHash)).toEqual([
            'tx-zzz',
            'tx-mmm',
            'tx-bbb',
            'tx-aaa',
         ]);
      });

      it('produces identical ordering regardless of page size', async () => {
         // With 5 items and varying page sizes, the first page should always
         // start with the same highest-priority item.
         const trades = [
            makeTrade({ id: 't1', ledger: 1000, txHash: 'tx-a' }),
            makeTrade({ id: 't2', ledger: 2000, txHash: 'tx-b' }),
            makeTrade({ id: 't3', ledger: 3000, txHash: 'tx-c' }),
            makeTrade({ id: 't4', ledger: 4000, txHash: 'tx-d' }),
            makeTrade({ id: 't5', ledger: 5000, txHash: 'tx-e' }),
         ];
         mockDb = createMockDb(trades);

         const page1 = await queryTradesPage(CREATOR_ID, null, 1, mockDb);
         const page2 = await queryTradesPage(CREATOR_ID, null, 2, mockDb);
         const page3 = await queryTradesPage(CREATOR_ID, null, 3, mockDb);

         // The first item should be the same regardless of page size
         expect(page1.items[0].id).toBe(page2.items[0].id);
         expect(page1.items[0].id).toBe(page3.items[0].id);
         expect(page1.items[0].id).toBe('t5');
      });

      it('produces identical ordering regardless of page size (shuffled input)', async () => {
         const base = [
            makeTrade({ id: 't1', ledger: 1000, txHash: 'tx-a' }),
            makeTrade({ id: 't2', ledger: 2000, txHash: 'tx-b' }),
            makeTrade({ id: 't3', ledger: 3000, txHash: 'tx-c' }),
            makeTrade({ id: 't4', ledger: 4000, txHash: 'tx-d' }),
            makeTrade({ id: 't5', ledger: 5000, txHash: 'tx-e' }),
         ];

         mockDb = createMockDb([...base]);
         const forward = await queryTradesPage(CREATOR_ID, null, 3, mockDb);

         mockDb = createMockDb([...base].reverse());
         const reverse = await queryTradesPage(CREATOR_ID, null, 3, mockDb);

         expect(forward.items.map(t => t.id)).toEqual(
            reverse.items.map(t => t.id)
         );
         expect(forward.items.map(t => t.id)).toEqual(['t5', 't4', 't3']);
      });

      it('orders correctly when page boundary falls within a same-ledger group', async () => {
         // 4 records at ledger 2000 and 1 at ledger 1000.
         // With limit 2, the page boundary falls in the middle of the
         // ledger-2000 group. The first two items must still be the two
         // highest txHash values at ledger 2000.
         const trades = [
            makeTrade({ id: 't1', ledger: 2000, txHash: 'tx-aaa' }),
            makeTrade({ id: 't2', ledger: 2000, txHash: 'tx-zzz' }),
            makeTrade({ id: 't3', ledger: 2000, txHash: 'tx-mmm' }),
            makeTrade({ id: 't4', ledger: 2000, txHash: 'tx-bbb' }),
            makeTrade({ id: 't5', ledger: 1000, txHash: 'tx-999' }),
         ];
         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 2, mockDb);

         expect(result.items.map(t => t.txHash)).toEqual(['tx-zzz', 'tx-mmm']);
         expect(result.has_more).toBe(true);
      });

      it('orders correctly when page boundary falls within a same-ledger group (shuffled input)', async () => {
         const base = [
            makeTrade({ id: 't1', ledger: 2000, txHash: 'tx-aaa' }),
            makeTrade({ id: 't2', ledger: 2000, txHash: 'tx-zzz' }),
            makeTrade({ id: 't3', ledger: 2000, txHash: 'tx-mmm' }),
            makeTrade({ id: 't4', ledger: 2000, txHash: 'tx-bbb' }),
            makeTrade({ id: 't5', ledger: 1000, txHash: 'tx-999' }),
         ];

         mockDb = createMockDb([...base]);
         const forward = await queryTradesPage(CREATOR_ID, null, 2, mockDb);

         mockDb = createMockDb([...base].reverse());
         const reverse = await queryTradesPage(CREATOR_ID, null, 2, mockDb);

         expect(forward.items.map(t => t.txHash)).toEqual(
            reverse.items.map(t => t.txHash)
         );
         expect(forward.items.map(t => t.txHash)).toEqual(['tx-zzz', 'tx-mmm']);
      });

      it('handles duplicate (ledger, txHash) pairs with stable relative order', async () => {
         // Two records share the exact same (ledger, txHash) — the composite
         // key is no longer unique. The orderBy cannot distinguish them, so
         // the relative order from the source is preserved (stable sort).
         // This test documents that behaviour: the items are still returned
         // in a deterministic order, and repeated calls are consistent.
         const trades = [
            makeTrade({ id: 't1', ledger: 2000, txHash: 'tx-same' }),
            makeTrade({ id: 't2', ledger: 2000, txHash: 'tx-same' }),
            makeTrade({ id: 't3', ledger: 1000, txHash: 'tx-other' }),
         ];
         mockDb = createMockDb(trades);

         const result1 = await queryTradesPage(CREATOR_ID, null, 10, mockDb);
         const result2 = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         // Both duplicate-key records appear before the lower-ledger record
         expect(result1.items.map(t => t.ledger)).toEqual([2000, 2000, 1000]);
         // Repeated calls are consistent
         expect(result1.items.map(t => t.id)).toEqual(
            result2.items.map(t => t.id)
         );
      });

      it('handles duplicate (ledger, txHash) pairs with stable relative order (shuffled input)', async () => {
         const base = [
            makeTrade({ id: 't1', ledger: 2000, txHash: 'tx-same' }),
            makeTrade({ id: 't2', ledger: 2000, txHash: 'tx-same' }),
            makeTrade({ id: 't3', ledger: 1000, txHash: 'tx-other' }),
         ];

         mockDb = createMockDb([...base]);
         const forward = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         mockDb = createMockDb([...base].reverse());
         const reverse = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         // The two duplicate-key records should both come before the
         // lower-ledger record in both runs.
         expect(forward.items.map(t => t.ledger)).toEqual([2000, 2000, 1000]);
         expect(reverse.items.map(t => t.ledger)).toEqual([2000, 2000, 1000]);
         // The duplicate-key pair should be the two ledger-2000 records
         expect(forward.items.slice(0, 2).map(t => t.txHash)).toEqual([
            'tx-same',
            'tx-same',
         ]);
         expect(reverse.items.slice(0, 2).map(t => t.txHash)).toEqual([
            'tx-same',
            'tx-same',
         ]);
      });

      it('maintains stable ordering with a large mixed dataset', async () => {
         // Build a larger dataset with multiple ledgers and multiple
         // txHashes per ledger to stress-test the composite ordering.
         const trades: TradeRecord[] = [];
         for (let ledger = 1; ledger <= 10; ledger++) {
            for (let tx = 1; tx <= 5; tx++) {
               trades.push(
                  makeTrade({
                     id: `l${ledger}-t${tx}`,
                     ledger: ledger * 1000,
                     txHash: `tx-${tx.toString().padStart(3, '0')}`,
                  })
               );
            }
         }

         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 50, mockDb);

         // All 50 items returned, no has_more
         expect(result.items).toHaveLength(50);
         expect(result.has_more).toBe(false);

         // Verify the ordering is strictly (ledger DESC, txHash DESC)
         for (let i = 1; i < result.items.length; i++) {
            const prev = result.items[i - 1];
            const curr = result.items[i];
            if (prev.ledger === curr.ledger) {
               expect(prev.txHash > curr.txHash).toBe(true);
            } else {
               expect(prev.ledger).toBeGreaterThan(curr.ledger);
            }
         }
      });

      it('maintains stable ordering with a large mixed dataset (shuffled input)', async () => {
         const trades: TradeRecord[] = [];
         for (let ledger = 1; ledger <= 10; ledger++) {
            for (let tx = 1; tx <= 5; tx++) {
               trades.push(
                  makeTrade({
                     id: `l${ledger}-t${tx}`,
                     ledger: ledger * 1000,
                     txHash: `tx-${tx.toString().padStart(3, '0')}`,
                  })
               );
            }
         }

         // Forward
         mockDb = createMockDb([...trades]);
         const forward = await queryTradesPage(CREATOR_ID, null, 50, mockDb);

         // Reverse
         mockDb = createMockDb([...trades].reverse());
         const reverse = await queryTradesPage(CREATOR_ID, null, 50, mockDb);

         expect(forward.items.map(t => t.id)).toEqual(
            reverse.items.map(t => t.id)
         );
      });

      it('produces consistent ordering across all pages when paginating a large dataset', async () => {
         // 12 items, page size 3 → 4 pages.
         // Collect all items across pages and verify they form a single
         // monotonically decreasing (ledger DESC, txHash DESC) sequence.
         const trades: TradeRecord[] = [];
         for (let ledger = 1; ledger <= 4; ledger++) {
            for (let tx = 1; tx <= 3; tx++) {
               trades.push(
                  makeTrade({
                     id: `l${ledger}-t${tx}`,
                     ledger: ledger * 1000,
                     txHash: `tx-${tx.toString().padStart(3, '0')}`,
                  })
               );
            }
         }

         mockDb = createMockDb(trades);

         const allItems: TradeRecord[] = [];
         let cursor: string | null = null;
         let hasMore = true;

         while (hasMore) {
            const result = await queryTradesPage(CREATOR_ID, cursor, 3, mockDb);
            allItems.push(...result.items);
            cursor = result.cursor;
            hasMore = result.has_more;
         }

         expect(allItems).toHaveLength(12);

         // Verify strict (ledger DESC, txHash DESC) ordering across pages
         for (let i = 1; i < allItems.length; i++) {
            const prev = allItems[i - 1];
            const curr = allItems[i];
            if (prev.ledger === curr.ledger) {
               expect(prev.txHash > curr.txHash).toBe(true);
            } else {
               expect(prev.ledger).toBeGreaterThan(curr.ledger);
            }
         }
      });

      it('produces consistent ordering across all pages (shuffled input)', async () => {
         const trades: TradeRecord[] = [];
         for (let ledger = 1; ledger <= 4; ledger++) {
            for (let tx = 1; tx <= 3; tx++) {
               trades.push(
                  makeTrade({
                     id: `l${ledger}-t${tx}`,
                     ledger: ledger * 1000,
                     txHash: `tx-${tx.toString().padStart(3, '0')}`,
                  })
               );
            }
         }

         // Forward
         mockDb = createMockDb([...trades]);
         const forwardItems: TradeRecord[] = [];
         {
            let cursor: string | null = null;
            let hasMore = true;
            while (hasMore) {
               const result = await queryTradesPage(
                  CREATOR_ID,
                  cursor,
                  3,
                  mockDb
               );
               forwardItems.push(...result.items);
               cursor = result.cursor;
               hasMore = result.has_more;
            }
         }

         // Reverse
         mockDb = createMockDb([...trades].reverse());
         const reverseItems: TradeRecord[] = [];
         {
            let cursor: string | null = null;
            let hasMore = true;
            while (hasMore) {
               const result = await queryTradesPage(
                  CREATOR_ID,
                  cursor,
                  3,
                  mockDb
               );
               reverseItems.push(...result.items);
               cursor = result.cursor;
               hasMore = result.has_more;
            }
         }

         expect(forwardItems.map(t => t.id)).toEqual(
            reverseItems.map(t => t.id)
         );
      });

      it('returns items in descending order when limit equals total count', async () => {
         const trades = [
            makeTrade({ id: 't1', ledger: 1000, txHash: 'tx-a' }),
            makeTrade({ id: 't2', ledger: 3000, txHash: 'tx-b' }),
            makeTrade({ id: 't3', ledger: 2000, txHash: 'tx-c' }),
         ];
         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 3, mockDb);

         expect(result.items.map(t => t.id)).toEqual(['t2', 't3', 't1']);
         expect(result.has_more).toBe(false);
      });

      it('returns items in descending order when limit equals total count (shuffled input)', async () => {
         const base = [
            makeTrade({ id: 't1', ledger: 1000, txHash: 'tx-a' }),
            makeTrade({ id: 't2', ledger: 3000, txHash: 'tx-b' }),
            makeTrade({ id: 't3', ledger: 2000, txHash: 'tx-c' }),
         ];

         mockDb = createMockDb([...base]);
         const forward = await queryTradesPage(CREATOR_ID, null, 3, mockDb);

         mockDb = createMockDb([...base].reverse());
         const reverse = await queryTradesPage(CREATOR_ID, null, 3, mockDb);

         expect(forward.items.map(t => t.id)).toEqual(
            reverse.items.map(t => t.id)
         );
         expect(forward.items.map(t => t.id)).toEqual(['t2', 't3', 't1']);
      });

      it('returns items in descending order when limit exceeds total count', async () => {
         const trades = [
            makeTrade({ id: 't1', ledger: 1000, txHash: 'tx-a' }),
            makeTrade({ id: 't2', ledger: 3000, txHash: 'tx-b' }),
         ];
         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 100, mockDb);

         expect(result.items.map(t => t.id)).toEqual(['t2', 't1']);
         expect(result.has_more).toBe(false);
      });

      it('returns items in descending order when limit exceeds total count (shuffled input)', async () => {
         const base = [
            makeTrade({ id: 't1', ledger: 1000, txHash: 'tx-a' }),
            makeTrade({ id: 't2', ledger: 3000, txHash: 'tx-b' }),
         ];

         mockDb = createMockDb([...base]);
         const forward = await queryTradesPage(CREATOR_ID, null, 100, mockDb);

         mockDb = createMockDb([...base].reverse());
         const reverse = await queryTradesPage(CREATOR_ID, null, 100, mockDb);

         expect(forward.items.map(t => t.id)).toEqual(
            reverse.items.map(t => t.id)
         );
         expect(forward.items.map(t => t.id)).toEqual(['t2', 't1']);
      });

      it('handles negative ledger values with stable ordering', async () => {
         const trades = [
            makeTrade({ id: 't1', ledger: -100, txHash: 'tx-a' }),
            makeTrade({ id: 't2', ledger: 500, txHash: 'tx-b' }),
            makeTrade({ id: 't3', ledger: -50, txHash: 'tx-c' }),
         ];
         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         // Descending: 500, -50, -100
         expect(result.items.map(t => t.ledger)).toEqual([500, -50, -100]);
      });

      it('handles negative ledger values with stable ordering (shuffled input)', async () => {
         const base = [
            makeTrade({ id: 't1', ledger: -100, txHash: 'tx-a' }),
            makeTrade({ id: 't2', ledger: 500, txHash: 'tx-b' }),
            makeTrade({ id: 't3', ledger: -50, txHash: 'tx-c' }),
         ];

         mockDb = createMockDb([...base]);
         const forward = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         mockDb = createMockDb([...base].reverse());
         const reverse = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         expect(forward.items.map(t => t.ledger)).toEqual(
            reverse.items.map(t => t.ledger)
         );
         expect(forward.items.map(t => t.ledger)).toEqual([500, -50, -100]);
      });

      it('handles zero ledger values with stable ordering', async () => {
         const trades = [
            makeTrade({ id: 't1', ledger: 0, txHash: 'tx-a' }),
            makeTrade({ id: 't2', ledger: 0, txHash: 'tx-b' }),
            makeTrade({ id: 't3', ledger: 100, txHash: 'tx-c' }),
            makeTrade({ id: 't4', ledger: -1, txHash: 'tx-d' }),
         ];
         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         // Descending: 100, 0/b, 0/a, -1
         expect(result.items.map(t => `${t.ledger}/${t.txHash}`)).toEqual([
            '100/tx-c',
            '0/tx-b',
            '0/tx-a',
            '-1/tx-d',
         ]);
      });

      it('handles zero ledger values with stable ordering (shuffled input)', async () => {
         const base = [
            makeTrade({ id: 't1', ledger: 0, txHash: 'tx-a' }),
            makeTrade({ id: 't2', ledger: 0, txHash: 'tx-b' }),
            makeTrade({ id: 't3', ledger: 100, txHash: 'tx-c' }),
            makeTrade({ id: 't4', ledger: -1, txHash: 'tx-d' }),
         ];

         mockDb = createMockDb([...base]);
         const forward = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         mockDb = createMockDb([...base].reverse());
         const reverse = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         expect(forward.items.map(t => t.id)).toEqual(
            reverse.items.map(t => t.id)
         );
         expect(forward.items.map(t => `${t.ledger}/${t.txHash}`)).toEqual([
            '100/tx-c',
            '0/tx-b',
            '0/tx-a',
            '-1/tx-d',
         ]);
      });

      it('handles unicode txHash values with stable ordering', async () => {
         const trades = [
            makeTrade({ id: 't1', ledger: 1000, txHash: 'tx-α' }),
            makeTrade({ id: 't2', ledger: 1000, txHash: 'tx-β' }),
            makeTrade({ id: 't3', ledger: 1000, txHash: 'tx-γ' }),
         ];
         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         // Descending: γ, β, α
         expect(result.items.map(t => t.txHash)).toEqual([
            'tx-γ',
            'tx-β',
            'tx-α',
         ]);
      });

      it('handles unicode txHash values with stable ordering (shuffled input)', async () => {
         const base = [
            makeTrade({ id: 't1', ledger: 1000, txHash: 'tx-α' }),
            makeTrade({ id: 't2', ledger: 1000, txHash: 'tx-β' }),
            makeTrade({ id: 't3', ledger: 1000, txHash: 'tx-γ' }),
         ];

         mockDb = createMockDb([...base]);
         const forward = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         mockDb = createMockDb([...base].reverse());
         const reverse = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         expect(forward.items.map(t => t.txHash)).toEqual(
            reverse.items.map(t => t.txHash)
         );
         expect(forward.items.map(t => t.txHash)).toEqual([
            'tx-γ',
            'tx-β',
            'tx-α',
         ]);
      });

      it('handles very long txHash strings with stable ordering', async () => {
         const longA = 'tx-' + 'a'.repeat(200);
         const longB = 'tx-' + 'b'.repeat(200);
         const longC = 'tx-' + 'c'.repeat(200);

         const trades = [
            makeTrade({ id: 't1', ledger: 1000, txHash: longA }),
            makeTrade({ id: 't2', ledger: 1000, txHash: longB }),
            makeTrade({ id: 't3', ledger: 1000, txHash: longC }),
         ];
         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         expect(result.items.map(t => t.txHash)).toEqual([longC, longB, longA]);
      });

      it('handles very long txHash strings with stable ordering (shuffled input)', async () => {
         const longA = 'tx-' + 'a'.repeat(200);
         const longB = 'tx-' + 'b'.repeat(200);
         const longC = 'tx-' + 'c'.repeat(200);

         const base = [
            makeTrade({ id: 't1', ledger: 1000, txHash: longA }),
            makeTrade({ id: 't2', ledger: 1000, txHash: longB }),
            makeTrade({ id: 't3', ledger: 1000, txHash: longC }),
         ];

         mockDb = createMockDb([...base]);
         const forward = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         mockDb = createMockDb([...base].reverse());
         const reverse = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         expect(forward.items.map(t => t.txHash)).toEqual(
            reverse.items.map(t => t.txHash)
         );
         expect(forward.items.map(t => t.txHash)).toEqual([
            longC,
            longB,
            longA,
         ]);
      });

      it('handles single-character txHash values with stable ordering', async () => {
         const trades = [
            makeTrade({ id: 't1', ledger: 1000, txHash: 'a' }),
            makeTrade({ id: 't2', ledger: 1000, txHash: 'z' }),
            makeTrade({ id: 't3', ledger: 1000, txHash: 'm' }),
         ];
         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         expect(result.items.map(t => t.txHash)).toEqual(['z', 'm', 'a']);
      });

      it('handles single-character txHash values with stable ordering (shuffled input)', async () => {
         const base = [
            makeTrade({ id: 't1', ledger: 1000, txHash: 'a' }),
            makeTrade({ id: 't2', ledger: 1000, txHash: 'z' }),
            makeTrade({ id: 't3', ledger: 1000, txHash: 'm' }),
         ];

         mockDb = createMockDb([...base]);
         const forward = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         mockDb = createMockDb([...base].reverse());
         const reverse = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         expect(forward.items.map(t => t.txHash)).toEqual(
            reverse.items.map(t => t.txHash)
         );
         expect(forward.items.map(t => t.txHash)).toEqual(['z', 'm', 'a']);
      });

      it('handles empty-string txHash values with stable ordering', async () => {
         const trades = [
            makeTrade({ id: 't1', ledger: 1000, txHash: '' }),
            makeTrade({ id: 't2', ledger: 2000, txHash: '' }),
            makeTrade({ id: 't3', ledger: 3000, txHash: '' }),
         ];
         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         // Descending ledger: 3000, 2000, 1000
         expect(result.items.map(t => t.ledger)).toEqual([3000, 2000, 1000]);
      });

      it('handles empty-string txHash values with stable ordering (shuffled input)', async () => {
         const base = [
            makeTrade({ id: 't1', ledger: 1000, txHash: '' }),
            makeTrade({ id: 't2', ledger: 2000, txHash: '' }),
            makeTrade({ id: 't3', ledger: 3000, txHash: '' }),
         ];

         mockDb = createMockDb([...base]);
         const forward = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         mockDb = createMockDb([...base].reverse());
         const reverse = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         expect(forward.items.map(t => t.id)).toEqual(
            reverse.items.map(t => t.id)
         );
         expect(forward.items.map(t => t.ledger)).toEqual([3000, 2000, 1000]);
      });

      it('handles txHash values with special characters with stable ordering', async () => {
         const trades = [
            makeTrade({ id: 't1', ledger: 1000, txHash: 'tx-!@#' }),
            makeTrade({ id: 't2', ledger: 1000, txHash: 'tx-$%^' }),
            makeTrade({ id: 't3', ledger: 1000, txHash: 'tx-abc' }),
         ];
         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         // Descending: tx-abc, tx-$%^, tx-!@#
         expect(result.items.map(t => t.txHash)).toEqual([
            'tx-abc',
            'tx-$%^',
            'tx-!@#',
         ]);
      });

      it('handles txHash values with special characters with stable ordering (shuffled input)', async () => {
         const base = [
            makeTrade({ id: 't1', ledger: 1000, txHash: 'tx-!@#' }),
            makeTrade({ id: 't2', ledger: 1000, txHash: 'tx-$%^' }),
            makeTrade({ id: 't3', ledger: 1000, txHash: 'tx-abc' }),
         ];

         mockDb = createMockDb([...base]);
         const forward = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         mockDb = createMockDb([...base].reverse());
         const reverse = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         expect(forward.items.map(t => t.txHash)).toEqual(
            reverse.items.map(t => t.txHash)
         );
         expect(forward.items.map(t => t.txHash)).toEqual([
            'tx-abc',
            'tx-$%^',
            'tx-!@#',
         ]);
      });

      it('handles txHash values with numeric suffixes with stable ordering', async () => {
         // Numeric string comparison vs lexicographic comparison — these
         // should sort lexicographically (not numerically) since txHash is
         // a string field.
         const trades = [
            makeTrade({ id: 't1', ledger: 1000, txHash: 'tx-2' }),
            makeTrade({ id: 't2', ledger: 1000, txHash: 'tx-10' }),
            makeTrade({ id: 't3', ledger: 1000, txHash: 'tx-1' }),
         ];
         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         // Lexicographic descending: 'tx-2' > 'tx-10' > 'tx-1'
         expect(result.items.map(t => t.txHash)).toEqual([
            'tx-2',
            'tx-10',
            'tx-1',
         ]);
      });

      it('handles txHash values with numeric suffixes with stable ordering (shuffled input)', async () => {
         const base = [
            makeTrade({ id: 't1', ledger: 1000, txHash: 'tx-2' }),
            makeTrade({ id: 't2', ledger: 1000, txHash: 'tx-10' }),
            makeTrade({ id: 't3', ledger: 1000, txHash: 'tx-1' }),
         ];

         mockDb = createMockDb([...base]);
         const forward = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         mockDb = createMockDb([...base].reverse());
         const reverse = await queryTradesPage(CREATOR_ID, null, 10, mockDb);

         expect(forward.items.map(t => t.txHash)).toEqual(
            reverse.items.map(t => t.txHash)
         );
         expect(forward.items.map(t => t.txHash)).toEqual([
            'tx-2',
            'tx-10',
            'tx-1',
         ]);
      });

      it('handles a single page with exactly one item at the boundary', async () => {
         // 3 items, limit 1 — first page should return the highest item
         const trades = [
            makeTrade({ id: 't1', ledger: 1000, txHash: 'tx-a' }),
            makeTrade({ id: 't2', ledger: 3000, txHash: 'tx-b' }),
            makeTrade({ id: 't3', ledger: 2000, txHash: 'tx-c' }),
         ];
         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 1, mockDb);

         expect(result.items).toHaveLength(1);
         expect(result.items[0].id).toBe('t2');
         expect(result.has_more).toBe(true);
      });

      it('handles a single page with exactly one item at the boundary (shuffled input)', async () => {
         const base = [
            makeTrade({ id: 't1', ledger: 1000, txHash: 'tx-a' }),
            makeTrade({ id: 't2', ledger: 3000, txHash: 'tx-b' }),
            makeTrade({ id: 't3', ledger: 2000, txHash: 'tx-c' }),
         ];

         mockDb = createMockDb([...base]);
         const forward = await queryTradesPage(CREATOR_ID, null, 1, mockDb);

         mockDb = createMockDb([...base].reverse());
         const reverse = await queryTradesPage(CREATOR_ID, null, 1, mockDb);

         expect(forward.items[0].id).toBe(reverse.items[0].id);
         expect(forward.items[0].id).toBe('t2');
      });

      it('handles all items on a single page with limit exceeding count', async () => {
         const trades = [
            makeTrade({ id: 't1', ledger: 1000, txHash: 'tx-a' }),
            makeTrade({ id: 't2', ledger: 2000, txHash: 'tx-b' }),
            makeTrade({ id: 't3', ledger: 3000, txHash: 'tx-c' }),
            makeTrade({ id: 't4', ledger: 4000, txHash: 'tx-d' }),
            makeTrade({ id: 't5', ledger: 5000, txHash: 'tx-e' }),
         ];
         mockDb = createMockDb(trades);

         const result = await queryTradesPage(CREATOR_ID, null, 100, mockDb);

         expect(result.items).toHaveLength(5);
         expect(result.has_more).toBe(false);
         expect(result.items.map(t => t.id)).toEqual([
            't5',
            't4',
            't3',
            't2',
            't1',
         ]);
      });

      it('handles all items on a single page with limit exceeding count (shuffled input)', async () => {
         const base = [
            makeTrade({ id: 't1', ledger: 1000, txHash: 'tx-a' }),
            makeTrade({ id: 't2', ledger: 2000, txHash: 'tx-b' }),
            makeTrade({ id: 't3', ledger: 3000, txHash: 'tx-c' }),
            makeTrade({ id: 't4', ledger: 4000, txHash: 'tx-d' }),
            makeTrade({ id: 't5', ledger: 5000, txHash: 'tx-e' }),
         ];

         mockDb = createMockDb([...base]);
         const forward = await queryTradesPage(CREATOR_ID, null, 100, mockDb);

         mockDb = createMockDb([...base].reverse());
         const reverse = await queryTradesPage(CREATOR_ID, null, 100, mockDb);

         expect(forward.items.map(t => t.id)).toEqual(
            reverse.items.map(t => t.id)
         );
         expect(forward.items.map(t => t.id)).toEqual([
            't5',
            't4',
            't3',
            't2',
            't1',
         ]);
      });
   });
});
