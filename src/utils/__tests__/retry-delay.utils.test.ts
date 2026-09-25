import { computeRetryDelay } from '../retry-delay.utils';

describe('computeRetryDelay', () => {
   let mathRandomSpy: jest.SpyInstance;

   beforeEach(() => {
      mathRandomSpy = jest.spyOn(Math, 'random');
   });

   afterEach(() => {
      mathRandomSpy.mockRestore();
   });

   it('returns approximately baseMs on attempt 0', () => {
      // Set random to 0 to test lower bound
      mathRandomSpy.mockReturnValue(0);
      expect(computeRetryDelay(0, 1000, 10000)).toBe(1000);

      // Set random to 0.99 to test upper bound of jitter
      mathRandomSpy.mockReturnValue(0.9999);
      // Computed delay is 1000. Jitter is 0.9999 * (0.2 * 1000) = ~200
      // Expect result to be around 1199
      expect(computeRetryDelay(0, 1000, 10000)).toBe(1199);
   });

   it('doubles the base delay on attempt 1 with jitter applied', () => {
      mathRandomSpy.mockReturnValue(0.5); // 10% jitter

      // base = 1000. attempt = 1 -> exponentialDelay = 2000
      // jitter = 0.5 * (0.2 * 2000) = 0.5 * 400 = 200
      // final delay = 2000 + 200 = 2200
      expect(computeRetryDelay(1, 1000, 10000)).toBe(2200);
   });

   it('doubles the delay on attempt 2', () => {
      mathRandomSpy.mockReturnValue(0);

      // base = 1000. attempt = 2 -> exponentialDelay = 4000
      // jitter = 0
      expect(computeRetryDelay(2, 1000, 10000)).toBe(4000);
   });

   it('caps the delay at maxMs even without jitter', () => {
      mathRandomSpy.mockReturnValue(0);

      // attempt 4 -> 1000 * 2^4 = 16000. Should cap at 10000
      expect(computeRetryDelay(4, 1000, 10000)).toBe(10000);
   });

   it('never exceeds maxMs even when jitter is applied at the max boundary', () => {
      mathRandomSpy.mockReturnValue(0.9999);

      // attempt 4 -> 16000. Caps at 10000.
      // jitter is applied to 10000 -> up to 2000.
      // Result would be 12000, but should be clamped to maxMs (10000).
      expect(computeRetryDelay(4, 1000, 10000)).toBe(10000);

      // Let's test a case right below maxMs where jitter would push it over
      // base = 1000, attempt = 3 -> 8000.
      // Max is 9000.
      // jitter on 8000 is up to 1600.
      // 8000 + 1600 = 9600 -> should cap at 9000.
      expect(computeRetryDelay(3, 1000, 9000)).toBe(9000);
   });
});
