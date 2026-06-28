// src/utils/test/heartbeat.service.test.ts

// Mock the config module before any imports that depend on it
jest.mock('../../config', () => ({
   envConfig: {
      INDEXER_HEARTBEAT_STALE_THRESHOLD_MS: 300_000,
   },
}));

import { HeartbeatService } from '../heartbeat.service';

describe('HeartbeatService', () => {
   let service: HeartbeatService;
   const STALE_THRESHOLD = 1_000; // 1 second for fast tests

   beforeEach(() => {
      service = new HeartbeatService('test-worker', STALE_THRESHOLD);
   });

   it('returns "unknown" when no heartbeat has been recorded', () => {
      const state = service.getStatus();

      expect(state).toEqual({
         service: 'test-worker',
         status: 'unknown',
         lastSuccessfulRun: null,
         staleSinceMs: null,
      });
   });

   it('returns "healthy" immediately after recording a heartbeat', () => {
      service.recordHeartbeat();
      const state = service.getStatus();

      expect(state.service).toBe('test-worker');
      expect(state.status).toBe('healthy');
      expect(state.lastSuccessfulRun).not.toBeNull();
      expect(state.staleSinceMs).toBeNull();
   });

   it('returns "degraded" when the heartbeat exceeds the stale threshold', () => {
      // Record a heartbeat far in the past
      service.recordHeartbeat();
      const pastDate = new Date(Date.now() - STALE_THRESHOLD - 500);
      // Access private field for deterministic testing
      (service as unknown as { lastSuccessfulRun: Date }).lastSuccessfulRun =
         pastDate;

      const state = service.getStatus();

      expect(state.status).toBe('degraded');
      expect(state.staleSinceMs).toBeGreaterThan(STALE_THRESHOLD);
      expect(state.lastSuccessfulRun).toBe(pastDate.toISOString());
   });

   it('returns a Date from recordHeartbeat()', () => {
      const before = Date.now();
      const result = service.recordHeartbeat();
      const after = Date.now();

      expect(result).toBeInstanceOf(Date);
      expect(result.getTime()).toBeGreaterThanOrEqual(before);
      expect(result.getTime()).toBeLessThanOrEqual(after);
   });

   it('resets state to unknown', () => {
      service.recordHeartbeat();
      expect(service.getStatus().status).toBe('healthy');

      service.reset();
      expect(service.getStatus().status).toBe('unknown');
   });

   it('respects a custom stale threshold', () => {
      const longService = new HeartbeatService('long-worker', 60_000);
      longService.recordHeartbeat();

      // Set heartbeat to 30 seconds ago — still within 60 s threshold
      const recentPast = new Date(Date.now() - 30_000);
      (
         longService as unknown as { lastSuccessfulRun: Date }
      ).lastSuccessfulRun = recentPast;

      expect(longService.getStatus().status).toBe('healthy');

      // Set heartbeat to 90 seconds ago — exceeds 60 s threshold
      const distantPast = new Date(Date.now() - 90_000);
      (
         longService as unknown as { lastSuccessfulRun: Date }
      ).lastSuccessfulRun = distantPast;

      expect(longService.getStatus().status).toBe('degraded');
   });
});
