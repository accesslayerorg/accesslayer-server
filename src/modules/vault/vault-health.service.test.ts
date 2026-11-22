import {
   accruedDebt,
   computeVaultHealth,
   HEALTH_WARNING_THRESHOLD,
   LIQUIDATION_THRESHOLD,
} from './vault-health.service';

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

describe('vault-health service', () => {
   const openedAt = new Date('2026-01-01T00:00:00Z');
   const base = {
      collateralQuantity: 10,
      principalXlm: 50,
      interestRateBps: 0,
      openedAt,
   };

   it('accrues simple interest from openedAt', () => {
      const debt = accruedDebt(
         { ...base, interestRateBps: 1000 },
         new Date(openedAt.getTime() + YEAR_MS)
      );
      expect(debt).toBeCloseTo(110, 6);
   });

   it('computes health = collateral value x threshold / debt', () => {
      const health = computeVaultHealth(base, 10, openedAt);

      expect(health.collateralValueXlm).toBe(100);
      expect(health.debtXlm).toBe(50);
      expect(health.healthFactor).toBeCloseTo((100 * LIQUIDATION_THRESHOLD) / 50, 6);
      // Price at which health would equal 1.
      expect(health.liquidationPriceXlm).toBeCloseTo(
         50 / (10 * LIQUIDATION_THRESHOLD),
         6
      );
   });

   it('flags a position below the warning threshold when collateral drops', () => {
      const health = computeVaultHealth(base, 7, openedAt);
      expect(health.healthFactor).toBeLessThan(HEALTH_WARNING_THRESHOLD);
   });

   it('caps health for a debt-free position and yields no price without collateral', () => {
      const health = computeVaultHealth(
         { ...base, collateralQuantity: 0, principalXlm: 0 },
         10,
         openedAt
      );
      expect(health.liquidationPriceXlm).toBeNull();
      expect(health.healthFactor).toBeGreaterThan(HEALTH_WARNING_THRESHOLD);
   });
});
