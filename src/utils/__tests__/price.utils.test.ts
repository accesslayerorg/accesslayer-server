import { compute24hPriceChange } from '../price.utils';

describe('compute24hPriceChange()', () => {
   it('returns a positive percentage when the price increases', () => {
      expect(compute24hPriceChange(120n, 100n)).toBe(20);
   });

   it('returns a negative percentage when the price decreases', () => {
      expect(compute24hPriceChange(80n, 100n)).toBe(-20);
   });

   it('returns 0 when the price is unchanged', () => {
      expect(compute24hPriceChange(100n, 100n)).toBe(0);
   });

   it('returns 0 when the previous price is zero', () => {
      expect(compute24hPriceChange(100n, 0n)).toBe(0);
   });

   it('rounds long decimal values to exactly two decimal places', () => {
      expect(compute24hPriceChange(101n, 3n)).toBe(3266.67);
   });
});
