import { applyJitter, getBackoffWithJitter } from '../jitter.utils';

jest.mock('../../config', () => ({
   envConfig: {
      INDEXER_JITTER_FACTOR: 0.1,
   },
}));

describe('jitter.utils', () => {
   describe('applyJitter', () => {
      it('should return a value within the jitter bounds', () => {
         const baseDelay = 1000;
         const jitterFactor = 0.1;
         const min = baseDelay * (1 - jitterFactor);
         const max = baseDelay * (1 + jitterFactor);

         for (let i = 0; i < 100; i++) {
            const result = applyJitter(baseDelay, jitterFactor);
            expect(result).toBeGreaterThanOrEqual(min);
            expect(result).toBeLessThanOrEqual(max);
         }
      });

      it('should default jitterFactor to 0.1', () => {
         const baseDelay = 1000;
         const min = baseDelay * 0.9;
         const max = baseDelay * 1.1;

         for (let i = 0; i < 100; i++) {
            const result = applyJitter(baseDelay);
            expect(result).toBeGreaterThanOrEqual(min);
            expect(result).toBeLessThanOrEqual(max);
         }
      });
   });

   describe('getBackoffWithJitter', () => {
      it('should exponentially increase delay', () => {
         const base = 1000;
         const attempt0 = getBackoffWithJitter(0, base);
         const attempt1 = getBackoffWithJitter(1, base);
         const attempt2 = getBackoffWithJitter(2, base);

         // With 0.1 jitter:
         // 0: 1000 -> [900, 1100]
         // 1: 2000 -> [1800, 2200]
         // 2: 4000 -> [3600, 4400]
         expect(attempt0).toBeLessThan(attempt1);
         expect(attempt1).toBeLessThan(attempt2);
      });

      it('should respect maxDelayMs', () => {
         const base = 1000;
         const max = 5000;
         const jitterFactor = 0.1;
         const absMax = max * (1 + jitterFactor);

         for (let i = 0; i < 100; i++) {
            // attempt 10 would be 1000 * 2^10 = 1024000, but should be capped at 5000
            const result = getBackoffWithJitter(10, base, max, jitterFactor);
            expect(result).toBeLessThanOrEqual(absMax);
         }
      });
   });
});
