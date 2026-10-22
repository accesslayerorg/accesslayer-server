// src/jobs/status-probe.job.test.ts
// Unit tests for the background 60s health probe job (#1015).

import {
   startStatusProbeJob,
   stopStatusProbeJob,
   triggerStatusProbeNow,
   isStatusProbeJobRunning,
} from './status-probe.job';
import * as statusService from '../modules/status/status.service';

jest.mock('../modules/status/status.service', () => ({
   runAllProbes: jest.fn().mockResolvedValue([]),
}));

describe('Status Health Probe Background Job', () => {
   beforeEach(() => {
      stopStatusProbeJob();
      jest.clearAllMocks();
      jest.useFakeTimers();
   });

   afterEach(() => {
      stopStatusProbeJob();
      jest.useRealTimers();
   });

   it('starts and stops probe job correctly', () => {
      expect(isStatusProbeJobRunning()).toBe(false);

      startStatusProbeJob();
      expect(isStatusProbeJobRunning()).toBe(true);

      stopStatusProbeJob();
      expect(isStatusProbeJobRunning()).toBe(false);
   });

   it('runs probes immediately on start, then repeats every 60 seconds', async () => {
      const runAllProbesMock = statusService.runAllProbes as jest.Mock;

      startStatusProbeJob();
      await Promise.resolve();
      expect(runAllProbesMock).toHaveBeenCalledTimes(1);

      // Advance by 60 seconds
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();
      expect(runAllProbesMock).toHaveBeenCalledTimes(2);

      // Advance by another 60 seconds
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();
      expect(runAllProbesMock).toHaveBeenCalledTimes(3);

      stopStatusProbeJob();
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();
      expect(runAllProbesMock).toHaveBeenCalledTimes(3); // Stopped, no further runs
   });

   it('prevents overlapping probe executions when a probe is in flight', async () => {
      let resolveSlowProbe!: () => void;
      const slowProbePromise = new Promise<any[]>(resolve => {
         resolveSlowProbe = () => resolve([]);
      });

      const runAllProbesMock = statusService.runAllProbes as jest.Mock;
      runAllProbesMock.mockImplementationOnce(() => slowProbePromise);

      // Start slow probe
      const firstRun = triggerStatusProbeNow();

      // Trigger another probe while first is still in flight
      await triggerStatusProbeNow();

      // Only one invocation should have occurred so far
      expect(runAllProbesMock).toHaveBeenCalledTimes(1);

      // Finish first probe
      resolveSlowProbe();
      await firstRun;

      // Now a new probe can be triggered
      runAllProbesMock.mockResolvedValueOnce([]);
      await triggerStatusProbeNow();
      expect(runAllProbesMock).toHaveBeenCalledTimes(2);
   });
});
