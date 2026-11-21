import { fetchWalletBundleTrades, fetchWalletTrades } from '../trades.service';
import { encodeCursor } from '../../../utils/cursor.utils';

jest.setTimeout(30000);

describe('Trades service unit tests', () => {
   const walletA = 'GWALLET_A_11111111111111111111111111111111111111111111111';
   const walletB = 'GWALLET_B_22222222222222222222222222222222222222222222222';

   const sampleBundleRows = [
      {
         id: 'b-1',
         wallet: walletA,
         buyer: walletA,
         totalCost: '50000',
         itemCount: 2,
         items: [
            { key: 'key-1', amount: 5, price: '4000' },
            { key: 'key-2', amount: 10, price: '3000' },
         ],
         ledger: 200,
         txHash: '0xhashB1',
         timestamp: new Date('2026-10-18T15:00:00.000Z'),
      },
      {
         id: 'b-2',
         wallet: walletA,
         buyer: walletA,
         totalCost: '20000',
         itemCount: 1,
         items: JSON.stringify([{ key: 'key-3', amount: 2, price: '10000' }]), // JSON string
         ledger: 100,
         txHash: '0xhashB2',
         timestamp: new Date('2026-10-18T12:00:00.000Z'),
      },
   ];

   const sampleSingleRows = [
      {
         id: 's-1',
         buyer: walletA,
         creatorId: 'key-1',
         quantity: '3',
         price: '4000',
         ledger: 150,
         txHash: '0xhashS1',
         paymentAsset: 'XLM',
         timestamp: new Date('2026-10-18T14:00:00.000Z'),
      },
   ];

   function createMockDb(
      bundleData = sampleBundleRows,
      singleData = sampleSingleRows
   ) {
      return {
         bundleTrade: {
            findMany: jest.fn(async (args?: any) => {
               let results = [...bundleData];
               if (args?.where?.timestamp?.gte) {
                  results = results.filter(
                     r => r.timestamp >= args.where.timestamp.gte
                  );
               }
               if (args?.where?.timestamp?.lte) {
                  results = results.filter(
                     r => r.timestamp <= args.where.timestamp.lte
                  );
               }
               return results;
            }),
         },
         trade: {
            findMany: jest.fn(async (args?: any) => {
               let results = [...singleData];
               if (args?.where?.timestamp?.gte) {
                  results = results.filter(
                     r => r.timestamp >= args.where.timestamp.gte
                  );
               }
               if (args?.where?.timestamp?.lte) {
                  results = results.filter(
                     r => r.timestamp <= args.where.timestamp.lte
                  );
               }
               return results;
            }),
         },
      };
   }

   describe('fetchWalletBundleTrades()', () => {
      it('returns parsed per-item breakdown whether items are pre-parsed array or JSON string', async () => {
         const db = createMockDb();
         const [items, total, cursor] = await fetchWalletBundleTrades(
            walletA,
            { limit: 10, offset: 0 },
            db as any
         );

         expect(total).toBe(2);
         expect(items).toHaveLength(2);
         expect(cursor).toBeNull(); // All items fit in page 1

         // Pre-parsed array
         expect(items[0].id).toBe('b-1');
         expect(items[0].items).toHaveLength(2);
         expect(items[0].items[0]).toEqual({
            key: 'key-1',
            creatorId: 'key-1',
            creator_id: 'key-1',
            amount: 5,
            quantity: 5,
            price: '4000',
         });

         // JSON string parsed
         expect(items[1].id).toBe('b-2');
         expect(items[1].items).toHaveLength(1);
         expect(items[1].items[0].key).toBe('key-3');
         expect(items[1].items[0].price).toBe('10000');
      });

      it('correctly creates cursor when hasMore is true and decodes cursor for next page', async () => {
         const db = createMockDb();
         const [page1, total1, cursor1] = await fetchWalletBundleTrades(
            walletA,
            { limit: 1, offset: 0 },
            db as any
         );

         expect(total1).toBe(2);
         expect(page1).toHaveLength(1);
         expect(page1[0].id).toBe('b-1');
         expect(cursor1).not.toBeNull();

         // Fetch page 2 using cursor
         const [page2, total2, cursor2] = await fetchWalletBundleTrades(
            walletA,
            { limit: 1, offset: 0, cursor: cursor1 as string },
            db as any
         );

         expect(total2).toBe(2);
         expect(page2).toHaveLength(1);
         expect(page2[0].id).toBe('b-2');
         expect(cursor2).toBeNull(); // Last item reached
      });

      it('applies date range filters (from, to)', async () => {
         const db = createMockDb();
         const [items] = await fetchWalletBundleTrades(
            walletA,
            {
               limit: 10,
               offset: 0,
               from: '2026-10-18T13:00:00.000Z',
               to: '2026-10-18T16:00:00.000Z',
            },
            db as any
         );

         expect(items).toHaveLength(1);
         expect(items[0].id).toBe('b-1');
      });

      it('gracefully handles missing bundleTrade model on db without throwing', async () => {
         const emptyDb = {};
         const [items, total] = await fetchWalletBundleTrades(
            walletB,
            { limit: 10, offset: 0 },
            emptyDb as any
         );
         expect(items).toEqual([]);
         expect(total).toBe(0);
      });
   });

   describe('fetchWalletTrades()', () => {
      it('merges single trades and bundle trades ordered by timestamp descending with type flags', async () => {
         const db = createMockDb();
         const [items, total] = await fetchWalletTrades(
            walletA,
            { limit: 10, offset: 0 },
            db as any
         );

         expect(total).toBe(3);
         expect(items).toHaveLength(3);

         // b-1 at 15:00
         expect(items[0].id).toBe('b-1');
         expect(items[0].type).toBe('bundle');

         // s-1 at 14:00
         expect(items[1].id).toBe('s-1');
         expect(items[1].type).toBe('single');

         // b-2 at 12:00
         expect(items[2].id).toBe('b-2');
         expect(items[2].type).toBe('bundle');
      });

      it('filters single trades only when type=single', async () => {
         const db = createMockDb();
         const [items, total] = await fetchWalletTrades(
            walletA,
            { limit: 10, offset: 0, type: 'single' },
            db as any
         );

         expect(total).toBe(1);
         expect(items).toHaveLength(1);
         expect(items[0].type).toBe('single');
         expect(items[0].id).toBe('s-1');
         expect(db.bundleTrade.findMany).not.toHaveBeenCalled();
      });

      it('filters bundle trades only when type=bundle', async () => {
         const db = createMockDb();
         const [items, total] = await fetchWalletTrades(
            walletA,
            { limit: 10, offset: 0, type: 'bundle' },
            db as any
         );

         expect(total).toBe(2);
         expect(items).toHaveLength(2);
         expect(items.every(it => it.type === 'bundle')).toBe(true);
         expect(db.trade.findMany).not.toHaveBeenCalled();
      });

      it('handles cursor pagination on merged trade stream', async () => {
         const db = createMockDb();
         const cursorPayload = encodeCursor({ id: 's-1', ledger: 150 });

         const [items] = await fetchWalletTrades(
            walletA,
            { limit: 2, offset: 0, cursor: cursorPayload },
            db as any
         );

         expect(items).toHaveLength(1);
         expect(items[0].id).toBe('b-2');
      });
   });
});
