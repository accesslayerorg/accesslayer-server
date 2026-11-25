jest.mock('../config', () => ({
   envConfig: { LP_REWARD_ACCRUAL_ENABLED: true, LP_FEE_BPS: 30 },
}));
jest.mock('../utils/logger.utils', () => ({
   logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../modules/lp-rewards/lp-reward-accrual.service', () => ({
   LP_REWARD_EPOCH_MS: 60 * 60 * 1000,
   LP_REWARD_SETTLE_MS: 60 * 1000,
   runLpRewardAccrual: jest.fn(),
}));

import { runLpRewardAccrual } from '../modules/lp-rewards/lp-reward-accrual.service';
import {
   msUntilNextLpRewardRun,
   runLpRewardAccrualTick,
   startLpRewardAccrualJob,
   stopLpRewardAccrualJob,
} from './lp-reward-accrual.job';

const run = runLpRewardAccrual as jest.Mock;

describe('lp-reward-accrual job', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      run.mockResolvedValue({});
   });

   afterEach(() => stopLpRewardAccrualJob());

   it('schedules the next run one settle delay after the next hour boundary', () => {
      expect(msUntilNextLpRewardRun(new Date('2026-11-22T10:30:00.000Z'))).toBe(31 * 60_000);
      expect(msUntilNextLpRewardRun(new Date('2026-11-22T10:00:30.000Z'))).toBe(30_000);
      expect(msUntilNextLpRewardRun(new Date('2026-11-22T10:01:00.000Z'))).toBe(60 * 60_000);
   });

   it('skips a tick while a previous run is still in progress', async () => {
      let release!: () => void;
      run.mockReturnValueOnce(new Promise<void>(resolve => (release = resolve)));
      const first = runLpRewardAccrualTick();
      await expect(runLpRewardAccrualTick()).resolves.toBe(false);
      release();
      await expect(first).resolves.toBe(true);
      expect(run).toHaveBeenCalledTimes(1);
   });

   it('swallows run failures so the schedule keeps going', async () => {
      run.mockRejectedValueOnce(new Error('boom'));
      await expect(runLpRewardAccrualTick()).resolves.toBe(false);
   });

   it('runs immediately on start and then on the hourly timer', async () => {
      jest.useFakeTimers({ now: new Date('2026-11-22T10:30:00.000Z') });
      try {
         startLpRewardAccrualJob();
         expect(run).toHaveBeenCalledTimes(1);
         await Promise.resolve();
         await jest.advanceTimersByTimeAsync(31 * 60_000);
         expect(run).toHaveBeenCalledTimes(2);
         await jest.advanceTimersByTimeAsync(60 * 60_000);
         expect(run).toHaveBeenCalledTimes(3);
      } finally {
         stopLpRewardAccrualJob();
         jest.useRealTimers();
      }
   });
});
