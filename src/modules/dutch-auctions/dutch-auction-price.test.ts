import {
   currentPrice,
   currentPriceStroops,
   endLedger,
   fromStroops,
   toStroops,
} from './dutch-auction-price';

const auction = {
   startPrice: '100',
   floorPrice: '10',
   startLedger: 1000,
   durationLedgers: 100,
};

describe('currentPrice', () => {
   it('equals the start price at the start ledger', () => {
      expect(currentPrice(auction, 1000)).toBe('100');
   });

   it('equals the start price before the start ledger', () => {
      expect(currentPrice(auction, 900)).toBe('100');
   });

   it('equals the floor price at the end ledger', () => {
      expect(currentPrice(auction, 1100)).toBe('10');
      expect(endLedger(auction)).toBe(1100);
   });

   it('stays at the floor price after the duration', () => {
      expect(currentPrice(auction, 1101)).toBe('10');
      expect(currentPrice(auction, 5000)).toBe('10');
   });

   // Vectors: price = start - floor((start - floor) * elapsed / duration),
   // computed in integer stroops.
   it.each([
      // [ledger, expected]
      [1000, '100'],
      [1001, '99.1'],
      [1010, '91'],
      [1025, '77.5'],
      [1050, '55'],
      [1075, '32.5'],
      [1099, '10.9'],
      [1100, '10'],
   ])('interpolates linearly at ledger %i', (ledger, expected) => {
      expect(currentPrice(auction, ledger)).toBe(expected);
   });

   it('rounds the decrease down to whole stroops', () => {
      // 10 stroops falling to 0 over 3 ledgers: decrease = floor(10 * n / 3).
      const tiny = {
         startPrice: '0.000001',
         floorPrice: '0',
         startLedger: 0,
         durationLedgers: 3,
      };
      expect(currentPriceStroops(tiny, 0)).toBe(10n);
      expect(currentPriceStroops(tiny, 1)).toBe(7n); // 10 - floor(10/3)
      expect(currentPriceStroops(tiny, 2)).toBe(4n); // 10 - floor(20/3)
      expect(currentPriceStroops(tiny, 3)).toBe(0n);
   });

   it('is monotonically non-increasing and bounded by start and floor', () => {
      let previous = toStroops(auction.startPrice);
      for (let ledger = 990; ledger <= 1110; ledger += 1) {
         const price = currentPriceStroops(auction, ledger);
         expect(price <= previous).toBe(true);
         expect(price >= toStroops(auction.floorPrice)).toBe(true);
         expect(price <= toStroops(auction.startPrice)).toBe(true);
         previous = price;
      }
   });

   it('handles amounts beyond Number.MAX_SAFE_INTEGER exactly', () => {
      const huge = {
         startPrice: '90071992547.4099199',
         floorPrice: '0',
         startLedger: 0,
         durationLedgers: 2,
      };
      expect(currentPrice(huge, 0)).toBe('90071992547.4099199');
      expect(currentPrice(huge, 1)).toBe('45035996273.70496');
      expect(currentPrice(huge, 2)).toBe('0');
   });

   it('returns the floor for a zero duration', () => {
      expect(
         currentPrice({ ...auction, durationLedgers: 0 }, auction.startLedger)
      ).toBe('10');
   });

   it('accepts Decimal-like values', () => {
      const decimal = { toString: () => '100.0000000' };
      expect(currentPrice({ ...auction, startPrice: decimal }, 1000)).toBe(
         '100'
      );
   });

   it('rejects a floor above the start price', () => {
      expect(() =>
         currentPrice({ ...auction, floorPrice: '101' }, 1000)
      ).toThrow('floorPrice must not exceed startPrice');
   });
});

describe('toStroops / fromStroops', () => {
   it('round-trips values', () => {
      for (const value of ['0', '1', '0.0000001', '12.3456789', '1000000']) {
         expect(fromStroops(toStroops(value))).toBe(value);
      }
   });

   it('rejects malformed or over-precise amounts', () => {
      expect(() => toStroops('-1')).toThrow('Invalid price amount');
      expect(() => toStroops('abc')).toThrow('Invalid price amount');
      expect(() => toStroops('1.00000001')).toThrow('more than 7 decimal');
   });
});
