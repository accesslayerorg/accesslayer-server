/**
 * Unit tests for rate limit tracking and threshold logging.
 *
 * Tests confirm that:
 * - 80% threshold log emitted once per window when crossed
 * - 100% threshold log emitted once per window when crossed
 * - Wallet address truncated in log
 * - Both logs contain all five fields (wallet_address, request_count, limit, window_reset_at, threshold)
 */

import {
   checkRateLimitThresholds,
   cleanupRateLimitState,
   resetRateLimitState,
} from '../rate-limit-tracking.utils';
import { logger } from '../logger.utils';

jest.mock('../logger.utils', () => ({
   logger: {
      warn: jest.fn(),
   },
}));

const mockLogger = logger as unknown as { warn: jest.Mock };

describe('rate-limit-tracking.utils', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      resetRateLimitState();
   });

   describe('checkRateLimitThresholds() — 80% threshold', () => {
      it('emits warn log when crossing 80% threshold', () => {
         const wallet =
            'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
         const limit = 100;
         const windowReset = new Date('2026-01-15T13:00:00Z');

         // Trigger at 80%
         checkRateLimitThresholds(wallet, 80, limit, windowReset);

         expect(mockLogger.warn).toHaveBeenCalledTimes(1);
         const call = mockLogger.warn.mock.calls[0];
         expect(call[0]).toMatchObject({
            wallet_address: 'GAAA…AAAA',
            request_count: 80,
            limit: 100,
            window_reset_at: '2026-01-15T13:00:00.000Z',
            threshold: '80%',
         });
      });

      it('emits log only once per window at 80% threshold', () => {
         const wallet =
            'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
         const limit = 100;
         const windowReset = new Date('2026-01-15T13:00:00Z');

         // Trigger at 80%
         checkRateLimitThresholds(wallet, 80, limit, windowReset);
         expect(mockLogger.warn).toHaveBeenCalledTimes(1);

         // Trigger again at 81% (should not log)
         checkRateLimitThresholds(wallet, 81, limit, windowReset);
         expect(mockLogger.warn).toHaveBeenCalledTimes(1);

         // Trigger at 99% (should not log)
         checkRateLimitThresholds(wallet, 99, limit, windowReset);
         expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      });

      it('emits log again in a new window', () => {
         const wallet =
            'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
         const limit = 100;
         const windowReset1 = new Date('2026-01-15T13:00:00Z');
         const windowReset2 = new Date('2026-01-15T13:15:00Z');

         // First window
         checkRateLimitThresholds(wallet, 80, limit, windowReset1);
         expect(mockLogger.warn).toHaveBeenCalledTimes(1);

         // Second window with new reset time
         checkRateLimitThresholds(wallet, 85, limit, windowReset2);
         expect(mockLogger.warn).toHaveBeenCalledTimes(2);
      });
   });

   describe('checkRateLimitThresholds() — 100% threshold', () => {
      it('emits warn log when hitting 100% of limit', () => {
         const wallet =
            'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
         const limit = 100;
         const windowReset = new Date('2026-01-15T13:00:00Z');

         checkRateLimitThresholds(wallet, 100, limit, windowReset);

         expect(mockLogger.warn).toHaveBeenCalledTimes(1);
         const call = mockLogger.warn.mock.calls[0];
         expect(call[0]).toMatchObject({
            wallet_address: 'GAAA…AAAA',
            request_count: 100,
            limit: 100,
            window_reset_at: '2026-01-15T13:00:00.000Z',
            threshold: '100%',
         });
      });

      it('emits log only once per window at 100% threshold', () => {
         const wallet =
            'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
         const limit = 100;
         const windowReset = new Date('2026-01-15T13:00:00Z');

         // Trigger at 100%
         checkRateLimitThresholds(wallet, 100, limit, windowReset);
         expect(mockLogger.warn).toHaveBeenCalledTimes(1);

         // Trigger again at 100% (should not log)
         checkRateLimitThresholds(wallet, 100, limit, windowReset);
         expect(mockLogger.warn).toHaveBeenCalledTimes(1);

         // Trigger at 101% (should not log again)
         checkRateLimitThresholds(wallet, 101, limit, windowReset);
         expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      });
   });

   describe('checkRateLimitThresholds() — both thresholds', () => {
      it('emits both 80% and 100% logs when crossing 100%', () => {
         const wallet =
            'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
         const limit = 100;
         const windowReset = new Date('2026-01-15T13:00:00Z');

         // Jump directly to 100%, should log both 80% and 100%
         checkRateLimitThresholds(wallet, 100, limit, windowReset);

         // Both thresholds should be logged
         expect(mockLogger.warn).toHaveBeenCalledTimes(2);
         const calls = mockLogger.warn.mock.calls;
         expect(calls[0][0].threshold).toBe('80%');
         expect(calls[1][0].threshold).toBe('100%');
      });

      it('logs only 80% if request count goes from 80 to 99', () => {
         const wallet =
            'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
         const limit = 100;
         const windowReset = new Date('2026-01-15T13:00:00Z');

         checkRateLimitThresholds(wallet, 80, limit, windowReset);
         expect(mockLogger.warn).toHaveBeenCalledTimes(1);

         checkRateLimitThresholds(wallet, 99, limit, windowReset);
         expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      });
   });

   describe('checkRateLimitThresholds() — log fields', () => {
      it('includes all five required fields in the warn log', () => {
         const wallet =
            'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
         const limit = 100;
         const windowReset = new Date('2026-01-15T13:00:00Z');

         checkRateLimitThresholds(wallet, 80, limit, windowReset);

         const logData = mockLogger.warn.mock.calls[0][0];
         expect(logData).toHaveProperty('wallet_address');
         expect(logData).toHaveProperty('request_count');
         expect(logData).toHaveProperty('limit');
         expect(logData).toHaveProperty('window_reset_at');
         expect(logData).toHaveProperty('threshold');
      });

      it('wallet_address is truncated in the log', () => {
         const wallet =
            'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
         const limit = 100;
         const windowReset = new Date('2026-01-15T13:00:00Z');

         checkRateLimitThresholds(wallet, 80, limit, windowReset);

         const logData = mockLogger.warn.mock.calls[0][0];
         expect(logData.wallet_address).toBe('GAAA…AAAA');
         expect(logData.wallet_address.length).toBeLessThan(wallet.length);
      });

      it('window_reset_at is in ISO format', () => {
         const wallet =
            'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
         const limit = 100;
         const windowReset = new Date('2026-01-15T13:00:00Z');

         checkRateLimitThresholds(wallet, 80, limit, windowReset);

         const logData = mockLogger.warn.mock.calls[0][0];
         const resetTime = new Date(logData.window_reset_at);
         expect(resetTime.getTime()).toBe(windowReset.getTime());
      });
   });

   describe('checkRateLimitThresholds() — edge cases', () => {
      it('ignores requests with empty wallet address', () => {
         checkRateLimitThresholds('', 80, 100, new Date());
         expect(mockLogger.warn).not.toHaveBeenCalled();
      });

      it('ignores requests with 0 request count', () => {
         checkRateLimitThresholds(
            'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            0,
            100,
            new Date()
         );
         expect(mockLogger.warn).not.toHaveBeenCalled();
      });

      it('ignores requests with 0 limit', () => {
         checkRateLimitThresholds(
            'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            50,
            0,
            new Date()
         );
         expect(mockLogger.warn).not.toHaveBeenCalled();
      });

      it('handles fractional percentages (e.g., 80.5%)', () => {
         const wallet =
            'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
         const limit = 1000;
         const windowReset = new Date('2026-01-15T13:00:00Z');

         checkRateLimitThresholds(wallet, 805, limit, windowReset);

         expect(mockLogger.warn).toHaveBeenCalled();
         const logData = mockLogger.warn.mock.calls[0][0];
         expect(logData.threshold).toBe('80%');
      });
   });

   describe('cleanupRateLimitState()', () => {
      it('removes old entries from tracking state', () => {
         const wallet =
            'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
         const limit = 100;
         const oldWindow = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
         const recentWindow = new Date();

         // Add old and recent entries
         checkRateLimitThresholds(wallet, 80, limit, oldWindow);
         checkRateLimitThresholds(wallet, 80, limit, recentWindow);

         // Both should have logged
         expect(mockLogger.warn).toHaveBeenCalledTimes(2);

         // Cleanup old entries (older than 30 minutes ago)
         const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
         cleanupRateLimitState(thirtyMinutesAgo);

         // Trying to log for the old window should log again (state was cleaned)
         mockLogger.warn.mockClear();
         checkRateLimitThresholds(wallet, 80, limit, oldWindow);
         expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      });
   });

   describe('resetRateLimitState()', () => {
      it('clears all tracking state', () => {
         const wallet =
            'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
         const limit = 100;
         const windowReset = new Date();

         checkRateLimitThresholds(wallet, 80, limit, windowReset);
         expect(mockLogger.warn).toHaveBeenCalledTimes(1);

         resetRateLimitState();
         mockLogger.warn.mockClear();

         // After reset, same threshold should log again
         checkRateLimitThresholds(wallet, 80, limit, windowReset);
         expect(mockLogger.warn).toHaveBeenCalledTimes(1);
      });
   });

   describe('different wallets tracked independently', () => {
      it('tracks different wallets separately', () => {
         const wallet1 =
            'GAAA1111111111111111111111111111111111111111111111111111';
         const wallet2 =
            'GBBB2222222222222222222222222222222222222222222222222222';
         const limit = 100;
         const windowReset = new Date();

         checkRateLimitThresholds(wallet1, 80, limit, windowReset);
         expect(mockLogger.warn).toHaveBeenCalledTimes(1);

         checkRateLimitThresholds(wallet2, 80, limit, windowReset);
         expect(mockLogger.warn).toHaveBeenCalledTimes(2);

         // Same threshold for wallet1 should not log again
         checkRateLimitThresholds(wallet1, 81, limit, windowReset);
         expect(mockLogger.warn).toHaveBeenCalledTimes(2);
      });
   });
});
