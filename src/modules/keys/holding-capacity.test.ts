import { calculateHoldingCapacity } from './keys.routes';

describe('calculateHoldingCapacity', () => {
   it('allows a quantity that fits within the wallet cap', () => {
      expect(
         calculateHoldingCapacity({
            circulatingSupply: 1_000,
            holderCapBps: 2_500,
            currentHolding: 100,
            quantity: 150,
         })
      ).toEqual({
         allowed: true,
         current_holding: 100,
         maximum_holding: 250,
         remaining_capacity: 150,
      });
   });

   it('rejects a quantity above the remaining capacity', () => {
      expect(
         calculateHoldingCapacity({
            circulatingSupply: 1_000,
            holderCapBps: 2_500,
            currentHolding: 100,
            quantity: 150.01,
         }).allowed
      ).toBe(false);
   });

   it('returns no remaining capacity when a legacy holding exceeds the cap', () => {
      expect(
         calculateHoldingCapacity({
            circulatingSupply: 100,
            holderCapBps: 1_000,
            currentHolding: 20,
            quantity: 1,
         })
      ).toMatchObject({
         allowed: false,
         maximum_holding: 10,
         remaining_capacity: 0,
      });
   });
});
