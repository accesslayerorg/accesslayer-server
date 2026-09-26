import { queryTradesPage, TradeRecord } from '../trade-pagination.utils';

function makeTrade(
   id: string,
   ledger: number,
   txHash: string,
   creatorId = 'creator-1'
): TradeRecord {
   return {
      id,
      buyer: 'GBUYER123',
      creatorId,
      quantity: '10',
      price: '100',
      ledger,
      txHash,
      timestamp: new Date(),
   };
}

function makeMockDb(allTrades: TradeRecord[]) {
   return {
      trade: {
         findMany: jest.fn(
            async ({
               where,
               _orderBy,
               take,
            }: {
               where: any;
               _orderBy?: any[];
               take: number;
            }) => {
               let filtered = allTrades.filter(
                  t => t.creatorId === where.creatorId
               );

               if (where.OR) {
                  const [ltLedger, eqLedgerLtHash] = where.OR;
                  filtered = filtered.filter(t => {
                     if (t.ledger < ltLedger.ledger.lt) return true;
                     if (
                        t.ledger === eqLedgerLtHash.ledger &&
                        t.txHash < eqLedgerLtHash.txHash.lt
                     )
                        return true;
                     return false;
                  });
               }

               // Order by ledger desc, txHash desc
               filtered.sort((a, b) => {
                  if (b.ledger !== a.ledger) return b.ledger - a.ledger;
                  return b.txHash.localeCompare(a.txHash);
               });

               return filtered.slice(0, take);
            }
         ),
      },
   };
}

describe('#625 queryTradesPage — keyset cursor pagination helper', () => {
   const trades: TradeRecord[] = [
      makeTrade('t5', 500, '0x05'),
      makeTrade('t4', 400, '0x04'),
      makeTrade('t3', 300, '0x03'),
      makeTrade('t2', 200, '0x02'),
      makeTrade('t1', 100, '0x01'),
   ];

   it('first page (null cursor) returns limit results ordered by ledger desc', async () => {
      const db = makeMockDb(trades);
      const res = await queryTradesPage('creator-1', null, 2, db);

      expect(res.items).toHaveLength(2);
      expect(res.items[0].id).toBe('t5');
      expect(res.items[1].id).toBe('t4');
      expect(res.has_more).toBe(true);
      expect(res.cursor).not.toBeNull();
   });

   it('cursor page returns results strictly after the cursor position', async () => {
      const db = makeMockDb(trades);

      // Fetch page 1
      const page1 = await queryTradesPage('creator-1', null, 2, db);
      expect(page1.items.map(i => i.id)).toEqual(['t5', 't4']);

      // Fetch page 2 using cursor from page 1
      const page2 = await queryTradesPage('creator-1', page1.cursor, 2, db);
      expect(page2.items.map(i => i.id)).toEqual(['t3', 't2']);
      expect(page2.has_more).toBe(true);
   });

   it('last page returns has_more: false and correct remaining results', async () => {
      const db = makeMockDb(trades);

      const page1 = await queryTradesPage('creator-1', null, 2, db);
      const page2 = await queryTradesPage('creator-1', page1.cursor, 2, db);
      const page3 = await queryTradesPage('creator-1', page2.cursor, 2, db);

      expect(page3.items.map(i => i.id)).toEqual(['t1']);
      expect(page3.has_more).toBe(false);
      expect(page3.cursor).toBeNull();
   });

   it('same record never appears across two consecutive pages', async () => {
      const db = makeMockDb(trades);

      const page1 = await queryTradesPage('creator-1', null, 2, db);
      const page2 = await queryTradesPage('creator-1', page1.cursor, 2, db);

      const page1Ids = new Set(page1.items.map(i => i.id));
      const page2Ids = page2.items.map(i => i.id);

      for (const id of page2Ids) {
         expect(page1Ids.has(id)).toBe(false);
      }
   });
});
