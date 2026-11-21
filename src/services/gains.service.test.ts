// Unit tests for realized gains (#1218): average-cost accounting.

jest.mock('../utils/prisma.utils', () => ({
   prisma: {
      trade: { findMany: jest.fn() },
      activityLog: { findMany: jest.fn() },
   },
}));

import { prisma } from '../utils/prisma.utils';
import {
   GainEvent,
   GainsService,
   computeAverageCostGains,
   formatStroops,
   toStroops,
   yearBoundsUtc,
} from './gains.service';

const XLM = 10_000_000n;
const { start: Y_START, end: Y_END } = yearBoundsUtc(2026);

let seq = 0;
function buy(
   keyId: string,
   quantity: number,
   priceXlm: number,
   iso: string
): GainEvent {
   return {
      kind: 'buy',
      keyId,
      at: new Date(iso),
      id: `b${seq++}`,
      quantity: BigInt(quantity),
      stroops: BigInt(quantity) * BigInt(priceXlm) * XLM,
   };
}
function sell(
   keyId: string,
   quantity: number,
   proceedsXlm: number,
   iso: string
): GainEvent {
   return {
      kind: 'sell',
      keyId,
      at: new Date(iso),
      id: `s${seq++}`,
      quantity: BigInt(quantity),
      stroops: BigInt(proceedsXlm) * XLM,
   };
}

describe('computeAverageCostGains', () => {
   it('gain equals proceeds minus average cost times quantity', () => {
      const { rows, totals } = computeAverageCostGains(
         [
            buy('k1', 10, 2, '2026-01-01T00:00:00Z'),
            sell('k1', 4, 12, '2026-02-01T00:00:00Z'),
         ],
         Y_START,
         Y_END
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
         keyId: 'k1',
         quantity: '4',
         proceeds: '12.0000000',
         costBasis: '8.0000000', // avg 2 * 4
         gain: '4.0000000',
         unmatchedQuantity: '0',
      });
      expect(totals).toEqual({
         proceeds: '12.0000000',
         costBasis: '8.0000000',
         gain: '4.0000000',
         sellCount: 1,
      });
   });

   it('averages multiple buys made at different prices', () => {
      // 10 @ 1 XLM + 10 @ 3 XLM => 20 keys costing 40 XLM => avg 2 XLM.
      const { rows } = computeAverageCostGains(
         [
            buy('k1', 10, 1, '2026-01-01T00:00:00Z'),
            buy('k1', 10, 3, '2026-01-02T00:00:00Z'),
            sell('k1', 5, 15, '2026-03-01T00:00:00Z'),
         ],
         Y_START,
         Y_END
      );
      expect(rows[0].costBasis).toBe('10.0000000');
      expect(rows[0].gain).toBe('5.0000000');
   });

   it('keeps the average cost across partial sells', () => {
      const { rows, totals } = computeAverageCostGains(
         [
            buy('k1', 10, 1, '2026-01-01T00:00:00Z'),
            buy('k1', 10, 3, '2026-01-02T00:00:00Z'),
            sell('k1', 5, 15, '2026-03-01T00:00:00Z'),
            sell('k1', 5, 8, '2026-04-01T00:00:00Z'),
         ],
         Y_START,
         Y_END
      );
      // Remaining position still averages 2 XLM, so both sells carry cost 10.
      expect(rows.map(r => r.costBasis)).toEqual(['10.0000000', '10.0000000']);
      expect(rows.map(r => r.gain)).toEqual(['5.0000000', '-2.0000000']);
      expect(totals.gain).toBe('3.0000000');
      expect(totals.sellCount).toBe(2);
   });

   it('re-averages when a buy follows a partial sell', () => {
      const { rows } = computeAverageCostGains(
         [
            buy('k1', 10, 2, '2026-01-01T00:00:00Z'),
            sell('k1', 5, 10, '2026-02-01T00:00:00Z'), // leaves 5 @ 2 (cost 10)
            buy('k1', 5, 4, '2026-03-01T00:00:00Z'), // 10 keys costing 30 => avg 3
            sell('k1', 2, 8, '2026-04-01T00:00:00Z'),
         ],
         Y_START,
         Y_END
      );
      expect(rows[1].costBasis).toBe('6.0000000');
      expect(rows[1].gain).toBe('2.0000000');
   });

   it('tracks each key independently for multi-key wallets', () => {
      const { rows, totals } = computeAverageCostGains(
         [
            buy('k1', 10, 1, '2026-01-01T00:00:00Z'),
            buy('k2', 10, 5, '2026-01-01T00:00:00Z'),
            sell('k2', 2, 12, '2026-02-01T00:00:00Z'),
            sell('k1', 2, 3, '2026-02-02T00:00:00Z'),
         ],
         Y_START,
         Y_END
      );
      const byKey = Object.fromEntries(rows.map(r => [r.keyId, r]));
      expect(byKey.k1.costBasis).toBe('2.0000000');
      expect(byKey.k1.gain).toBe('1.0000000');
      expect(byKey.k2.costBasis).toBe('10.0000000');
      expect(byKey.k2.gain).toBe('2.0000000');
      expect(totals).toEqual({
         proceeds: '15.0000000',
         costBasis: '12.0000000',
         gain: '3.0000000',
         sellCount: 2,
      });
   });

   it('uses buys and sells from earlier years but only reports sells in the year', () => {
      const { rows, totals } = computeAverageCostGains(
         [
            buy('k1', 10, 2, '2025-06-01T00:00:00Z'),
            sell('k1', 4, 10, '2025-07-01T00:00:00Z'), // prior-year sell: consumes cost, not reported
            sell('k1', 3, 9, '2026-05-01T00:00:00Z'),
            sell('k1', 1, 1, '2027-01-01T00:00:00Z'), // after the year: excluded
         ],
         Y_START,
         Y_END
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].costBasis).toBe('6.0000000');
      expect(totals.sellCount).toBe(1);
   });

   it('treats the year as [Jan 1 00:00 UTC, next Jan 1 00:00 UTC)', () => {
      const { rows } = computeAverageCostGains(
         [
            buy('k1', 10, 1, '2025-01-01T00:00:00Z'),
            sell('k1', 1, 1, '2025-12-31T23:59:59.999Z'),
            sell('k1', 1, 1, '2026-01-01T00:00:00Z'),
            sell('k1', 1, 1, '2026-12-31T23:59:59.999Z'),
            sell('k1', 1, 1, '2027-01-01T00:00:00Z'),
         ],
         Y_START,
         Y_END
      );
      expect(rows.map(r => r.date)).toEqual([
         '2026-01-01T00:00:00.000Z',
         '2026-12-31T23:59:59.999Z',
      ]);
   });

   it('returns no rows and zero totals when there are no sells in the year', () => {
      const result = computeAverageCostGains(
         [buy('k1', 10, 2, '2026-01-01T00:00:00Z')],
         Y_START,
         Y_END
      );
      expect(result.rows).toEqual([]);
      expect(result.totals).toEqual({
         proceeds: '0.0000000',
         costBasis: '0.0000000',
         gain: '0.0000000',
         sellCount: 0,
      });
   });

   it('flags sold keys that have no buy history and uses zero cost for them', () => {
      const { rows } = computeAverageCostGains(
         [
            buy('k1', 2, 2, '2026-01-01T00:00:00Z'),
            sell('k1', 5, 20, '2026-02-01T00:00:00Z'),
         ],
         Y_START,
         Y_END
      );
      expect(rows[0].costBasis).toBe('4.0000000');
      expect(rows[0].gain).toBe('16.0000000');
      expect(rows[0].unmatchedQuantity).toBe('3');
   });

   it('replays buys before sells that share a timestamp and ignores input order', () => {
      const { rows } = computeAverageCostGains(
         [
            sell('k1', 1, 5, '2026-02-01T00:00:00Z'),
            buy('k1', 1, 2, '2026-02-01T00:00:00Z'),
         ],
         Y_START,
         Y_END
      );
      expect(rows[0].costBasis).toBe('2.0000000');
      expect(rows[0].unmatchedQuantity).toBe('0');
   });

   it('rounds cost basis to the nearest stroop without drifting the pool', () => {
      // 3 keys for 1 stroop total: selling one at a time must consume exactly
      // the whole cost across the three sells.
      const events: GainEvent[] = [
         {
            kind: 'buy',
            keyId: 'k1',
            at: new Date('2026-01-01T00:00:00Z'),
            id: 'b',
            quantity: 3n,
            stroops: 1n,
         },
         ...[1, 2, 3].map(
            (n): GainEvent => ({
               kind: 'sell',
               keyId: 'k1',
               at: new Date(`2026-02-0${n}T00:00:00Z`),
               id: `s${n}`,
               quantity: 1n,
               stroops: 0n,
            })
         ),
      ];
      const { totals } = computeAverageCostGains(events, Y_START, Y_END);
      expect(totals.costBasis).toBe('0.0000001');
   });
});

describe('stroop helpers', () => {
   it('formats and parses without floating-point error', () => {
      expect(formatStroops(0n)).toBe('0.0000000');
      expect(formatStroops(-15_000_000n)).toBe('-1.5000000');
      expect(formatStroops(1n)).toBe('0.0000001');
      expect(toStroops('1.5')).toBe(15_000_000n);
      expect(toStroops(0.1)).toBe(1_000_000n);
      expect(toStroops({ toFixed: (d: number) => (2.25).toFixed(d) })).toBe(
         22_500_000n
      );
      expect(toStroops('abc')).toBeNull();
      expect(toStroops(null)).toBeNull();
   });

   it('computes year bounds in UTC', () => {
      expect(yearBoundsUtc(2026).start.toISOString()).toBe(
         '2026-01-01T00:00:00.000Z'
      );
      expect(yearBoundsUtc(2026).end.toISOString()).toBe(
         '2027-01-01T00:00:00.000Z'
      );
   });
});

describe('GainsService.computeRealizedGains', () => {
   const WALLET = 'GWALLET';
   const tradeFindMany = prisma.trade.findMany as unknown as jest.Mock;
   const logFindMany = prisma.activityLog.findMany as unknown as jest.Mock;

   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('queries XLM buys and sells up to year end and computes gains', async () => {
      tradeFindMany.mockResolvedValue([
         {
            id: 't1',
            creatorId: 'k1',
            quantity: '10',
            price: String(2n * XLM),
            timestamp: new Date('2025-12-01T00:00:00Z'),
         },
         // malformed rows are skipped, not fatal
         {
            id: 't2',
            creatorId: 'k1',
            quantity: 'x',
            price: '1',
            timestamp: new Date('2026-01-01T00:00:00Z'),
         },
      ]);
      logFindMany.mockResolvedValue([
         {
            id: 's1',
            keyId: 'k1',
            amount: { toFixed: (d: number) => (12).toFixed(d) },
            payload: { quantity: 4 },
            timestamp: new Date('2026-03-01T00:00:00Z'),
         },
      ]);

      const result = await GainsService.computeRealizedGains(WALLET, 2026);

      expect(tradeFindMany).toHaveBeenCalledWith(
         expect.objectContaining({
            where: {
               buyer: WALLET,
               paymentAsset: 'XLM',
               timestamp: { lt: new Date('2027-01-01T00:00:00.000Z') },
            },
         })
      );
      expect(logFindMany).toHaveBeenCalledWith(
         expect.objectContaining({
            where: expect.objectContaining({ actor: WALLET, type: 'sell' }),
         })
      );
      expect(result.wallet).toBe(WALLET);
      expect(result.year).toBe(2026);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({
         quantity: '4',
         proceeds: '12.0000000',
         costBasis: '8.0000000',
         gain: '4.0000000',
      });
   });

   it('returns zero totals for a wallet with no sells', async () => {
      tradeFindMany.mockResolvedValue([
         {
            id: 't1',
            creatorId: 'k1',
            quantity: '10',
            price: String(XLM),
            timestamp: new Date('2026-01-01T00:00:00Z'),
         },
      ]);
      logFindMany.mockResolvedValue([]);

      const result = await GainsService.computeRealizedGains(WALLET, 2026);
      expect(result.rows).toEqual([]);
      expect(result.totals).toEqual({
         proceeds: '0.0000000',
         costBasis: '0.0000000',
         gain: '0.0000000',
         sellCount: 0,
      });
   });

   it('falls back to payload.payoutXlm when amount is absent', async () => {
      tradeFindMany.mockResolvedValue([
         {
            id: 't1',
            creatorId: 'k1',
            quantity: '2',
            price: String(XLM),
            timestamp: new Date('2026-01-01T00:00:00Z'),
         },
      ]);
      logFindMany.mockResolvedValue([
         {
            id: 's1',
            keyId: 'k1',
            amount: null,
            payload: { quantity: 1, payoutXlm: 1.5 },
            timestamp: new Date('2026-02-01T00:00:00Z'),
         },
      ]);
      const result = await GainsService.computeRealizedGains(WALLET, 2026);
      expect(result.rows[0].proceeds).toBe('1.5000000');
      expect(result.rows[0].gain).toBe('0.5000000');
   });
});
