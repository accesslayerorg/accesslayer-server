import { claimable } from './stream-claimable.utils';

describe('claimable (#1331)', () => {
   it('caps accrual at funded minus withdrawn and excludes paused ledgers', () => {
      expect(
         claimable({
            rate: 10,
            startLedger: 0,
            currentLedger: 100,
            funded: 500,
            withdrawn: 100,
            pausedLedgers: 20,
         })
      ).toBe(400); // 10 * (100 - 20) = 800, capped at 500 - 100
   });
});
