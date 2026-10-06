// src/modules/keys/key-milestones.service.test.ts
import {
   getTierForSupply,
   MILESTONES,
   type Milestone,
} from './key-milestones.service';

describe('key-milestones.service', () => {
   describe('getTierForSupply', () => {
      it('returns tier 0 for supply less than the first threshold', () => {
         expect(getTierForSupply(0)).toBe(0);
         expect(getTierForSupply(5)).toBe(0);
         expect(getTierForSupply(9)).toBe(0);
      });

      it('returns correct tier for threshold boundaries', () => {
         // Milestone thresholds: 10, 100, 1000, 10000
         expect(getTierForSupply(10)).toBe(1);
         expect(getTierForSupply(99)).toBe(1);
         expect(getTierForSupply(100)).toBe(2);
         expect(getTierForSupply(999)).toBe(2);
         expect(getTierForSupply(1000)).toBe(3);
         expect(getTierForSupply(9999)).toBe(3);
         expect(getTierForSupply(10000)).toBe(4);
         expect(getTierForSupply(50000)).toBe(4);
      });

      it('accepts a custom milestone configuration', () => {
         const customMilestones: Milestone[] = [
            { tier: 1, threshold: 20 },
            { tier: 2, threshold: 50 },
         ];

         expect(getTierForSupply(0, customMilestones)).toBe(0);
         expect(getTierForSupply(20, customMilestones)).toBe(1);
         expect(getTierForSupply(49, customMilestones)).toBe(1);
         expect(getTierForSupply(50, customMilestones)).toBe(2);
      });

      it('supports metadata-provided thresholds without mutating the default list', () => {
         const configuredMilestones: Milestone[] = [
            { tier: 1, threshold: 25 },
            { tier: 2, threshold: 75 },
         ];

         expect(getTierForSupply(25, configuredMilestones)).toBe(1);
         expect(getTierForSupply(75, configuredMilestones)).toBe(2);
         expect(MILESTONES).not.toEqual(configuredMilestones);
      });
   });
});
