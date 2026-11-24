import { detectWashTrades, WashTradeDetector, TradeRecord } from './wash-trade.service';

const base = (over: Partial<TradeRecord>): TradeRecord => ({
   id: 't1',
   buyer: 'W1',
   creatorId: 'K1',
   quantity: '1',
   price: '10',
   ledger: 100,
   timestamp: new Date('2024-01-01T00:00:00Z'),
   ...over,
});

describe('detectWashTrades', () => {
   it('flags a buy-then-sell round trip by one wallet within the window', () => {
      const trades = [
         base({ id: 'a', ledger: 100 }),
         base({ id: 'b', ledger: 105 }),
      ];
      const flags = detectWashTrades(trades, [], 10);
      expect(flags.map(f => f.tradeId).sort()).toEqual(['a', 'b']);
      expect(flags.every(f => f.rule === 'ROUND_TRIP')).toBe(true);
   });

   it('does not flag round trips outside the ledger gap', () => {
      const trades = [
         base({ id: 'a', ledger: 100 }),
         base({ id: 'b', ledger: 500 }),
      ];
      expect(detectWashTrades(trades, [], 10)).toEqual([]);
   });

   it('flags wallets funded by the same source trading the same key in a cycle', () => {
      const trades = [
         base({ id: 'a', buyer: 'W1', ledger: 100 }),
         base({ id: 'b', buyer: 'W2', ledger: 102 }),
      ];
      const funding = [
         { wallet: 'W1', funderAccount: 'F' },
         { wallet: 'W2', funderAccount: 'F' },
      ];
      const flags = detectWashTrades(trades, funding, 10);
      expect(flags.find(f => f.tradeId === 'a')?.rule).toBe('FUNDING_CYCLE');
      expect(flags.find(f => f.tradeId === 'b')?.rule).toBe('FUNDING_CYCLE');
   });

   it('does not flag legitimate trades between unrelated wallets', () => {
      const trades = [
         base({ id: 'a', buyer: 'W1', ledger: 100 }),
         base({ id: 'b', buyer: 'W2', ledger: 101 }),
      ];
      const funding = [
         { wallet: 'W1', funderAccount: 'F1' },
         { wallet: 'W2', funderAccount: 'F2' },
      ];
      expect(detectWashTrades(trades, funding, 10)).toEqual([]);
   });
});

describe('WashTradeDetector.analyze', () => {
   it('does not create duplicate flags on re-run', async () => {
      const existing: { tradeId: string; rule: string }[] = [];
      const db = {
         trade: {
            findMany: jest.fn().mockResolvedValue([
               base({ id: 'a', ledger: 100 }),
               base({ id: 'b', ledger: 105 }),
            ]),
         },
         walletFunding: { findMany: jest.fn().mockResolvedValue([]) },
         tradeFlag: {
            findMany: jest.fn(async () => existing),
            createMany: jest.fn(async ({ data }: any) => {
               existing.push(...data);
               return { count: data.length };
            }),
         },
      };
      const detector = new WashTradeDetector(db);
      const window = { start: new Date(0), end: new Date(), maxLedgerGap: 10 };

      const first = await detector.analyze(window);
      const second = await detector.analyze(window);

      expect(first).toBe(2);
      expect(second).toBe(0);
      expect(db.tradeFlag.createMany).toHaveBeenCalledTimes(1);
   });
});
