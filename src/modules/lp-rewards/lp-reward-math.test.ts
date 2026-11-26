import {
   allocateProRata,
   computeLpFeeAllocation,
   formatScaled,
   InvalidLpAmountError,
   parseScaled,
   parseUnits,
   percentOf,
   sumTradeVolume,
   weightedEntryPrice,
} from './lp-reward-math';

describe('lp-reward-math', () => {
   describe('parseScaled / formatScaled', () => {
      it.each([
         ['0', 0n],
         ['1', 10_000_000n],
         ['1.5', 15_000_000n],
         ['0.0000001', 1n],
         ['12.3400000', 123_400_000n],
         ['  7 ', 70_000_000n],
      ])('parses %s', (input, expected) => {
         expect(parseScaled(input)).toBe(expected);
      });

      it('parses Decimal-like objects via toFixed', () => {
         expect(parseScaled({ toFixed: () => '2.5000000' })).toBe(25_000_000n);
      });

      it.each(['-1', '1e5', 'abc', '', '0.00000001', '1.2.3'])('rejects %s', input => {
         expect(() => parseScaled(input)).toThrow(InvalidLpAmountError);
      });

      it('round-trips', () => {
         expect(formatScaled(parseScaled('123.4567890'))).toBe('123.4567890');
         expect(formatScaled(1n)).toBe('0.0000001');
         expect(formatScaled(0n)).toBe('0.0000000');
         expect(formatScaled(42n, 0)).toBe('42');
      });

      it('parseUnits only accepts integers', () => {
         expect(parseUnits('1000')).toBe(1000n);
         expect(parseUnits('1000.000')).toBe(1000n);
         expect(() => parseUnits('1.5')).toThrow(InvalidLpAmountError);
      });
   });

   describe('sumTradeVolume', () => {
      it('sums price * quantity and counts unparseable rows', () => {
         const result = sumTradeVolume([
            { price: '100', quantity: '3' },
            { price: '25', quantity: '4' },
            { price: '1.5', quantity: '2' },
            { price: '-5', quantity: '1' },
         ]);
         expect(result).toEqual({ volume: 400n, skipped: 2 });
      });
   });

   describe('computeLpFeeAllocation', () => {
      it('takes floor(volume * bps / 10000)', () => {
         expect(computeLpFeeAllocation(1_000_000n, 30)).toBe(3_000n);
         expect(computeLpFeeAllocation(333n, 30)).toBe(0n);
         expect(computeLpFeeAllocation(10_000n, 10_000)).toBe(10_000n);
         expect(computeLpFeeAllocation(0n, 30)).toBe(0n);
      });

      it.each([-1, 10_001, 1.5])('rejects bps %s', bps => {
         expect(() => computeLpFeeAllocation(1n, bps)).toThrow(RangeError);
      });
   });

   describe('allocateProRata', () => {
      it('splits exactly when divisible', () => {
         expect(allocateProRata(1000n, [1n, 3n])).toEqual([250n, 750n]);
      });

      it('distributes the remainder by largest fractional part and conserves the pool', () => {
         const shares = allocateProRata(100n, [1n, 1n, 1n]);
         expect(shares).toEqual([34n, 33n, 33n]);
         expect(shares.reduce((a, b) => a + b, 0n)).toBe(100n);
      });

      it('keeps every share within one unit of its exact value', () => {
         const weights = [7n, 13n, 29n, 1n, 50n];
         const pool = 9_999n;
         const total = weights.reduce((a, b) => a + b, 0n);
         const shares = allocateProRata(pool, weights);
         expect(shares.reduce((a, b) => a + b, 0n)).toBe(pool);
         shares.forEach((share, i) => {
            const exactFloor = (pool * weights[i]) / total;
            expect(share === exactFloor || share === exactFloor + 1n).toBe(true);
         });
      });

      it('gives nothing to zero weights', () => {
         expect(allocateProRata(10n, [0n, 1n, 0n])).toEqual([0n, 10n, 0n]);
      });

      it('returns zeros when there is no pool or no weight', () => {
         expect(allocateProRata(0n, [1n, 2n])).toEqual([0n, 0n]);
         expect(allocateProRata(10n, [0n, 0n])).toEqual([0n, 0n]);
         expect(allocateProRata(10n, [])).toEqual([]);
      });
   });

   describe('percentOf', () => {
      it('formats a truncated percentage', () => {
         expect(percentOf(1n, 3n)).toBe('33.3333');
         expect(percentOf(5n, 5n)).toBe('100.0000');
         expect(percentOf(0n, 5n)).toBe('0.0000');
         expect(percentOf(5n, 0n)).toBe('0.0000');
      });
   });

   describe('weightedEntryPrice', () => {
      it('averages by token weight', () => {
         const price = weightedEntryPrice(
            parseScaled('100'),
            parseScaled('2'),
            parseScaled('100'),
            parseScaled('4')
         );
         expect(formatScaled(price)).toBe('3.0000000');
      });

      it('uses the deposit price for an empty position', () => {
         expect(weightedEntryPrice(0n, 0n, 10n, 55n)).toBe(55n);
      });
   });
});
