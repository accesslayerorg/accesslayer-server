// src/workers/dca-executor.worker.test.ts
import {
   DcaExecutorWorker,
   DcaExecutionClient,
   DueDcaPlan,
} from './dca-executor.worker';
import { dcaEventEmitter } from '../modules/dca/dca.events';

const mockTx = {
   $queryRaw: jest.fn(),
   dcaRun: {
      findUnique: jest.fn(),
      create: jest.fn(),
   },
   dcaPlan: {
      update: jest.fn(),
   },
};

jest.mock('../utils/prisma.utils', () => ({
   prisma: {
      $transaction: jest.fn(async fn => fn(mockTx)),
   },
}));

describe('DcaExecutorWorker (#1322)', () => {
   const now = new Date('2026-11-24T12:00:00Z');
   const basePlan: DueDcaPlan = {
      id: 'plan-1',
      wallet: 'GWALLET',
      keyId: 'key-1',
      amount: 10_000_000n,
      frequency: 'daily',
      nextRunAt: new Date('2026-11-24T11:55:00Z'),
      budgetRemaining: 50_000_000n,
      status: 'active',
      maxSlippageBps: 100,
      spendingAuth: 'AAAA_PRESIGNED_AUTH',
      consecutiveFailures: 0,
   };

   let client: jest.Mocked<DcaExecutionClient>;

   beforeEach(() => {
      jest.clearAllMocks();
      client = {
         getWalletBalance: jest.fn().mockResolvedValue(100_000_000n),
         getSlippageBps: jest.fn().mockResolvedValue(50),
         executeBuyWithAuth: jest.fn().mockResolvedValue({
            txHash: 'txhash123',
            txXdr: 'XDR_DATA',
            amountSpent: 10_000_000n,
         }),
      };
      mockTx.$queryRaw.mockResolvedValue([{ ...basePlan }]);
      mockTx.dcaRun.findUnique.mockResolvedValue(null);
   });

   it('executes due plan, records run, and decrements budgetRemaining', async () => {
      const worker = new DcaExecutorWorker(client, { now: () => now });
      const count = await worker.tick();

      expect(count).toBe(1);
      expect(client.executeBuyWithAuth).toHaveBeenCalledTimes(1);
      expect(mockTx.dcaRun.create).toHaveBeenCalledWith({
         data: expect.objectContaining({
            planId: 'plan-1',
            status: 'executed',
            amountSpent: 10_000_000n,
            txHash: 'txhash123',
         }),
      });
      expect(mockTx.dcaPlan.update).toHaveBeenCalledWith({
         where: { id: 'plan-1' },
         data: expect.objectContaining({
            budgetRemaining: 40_000_000n,
            consecutiveFailures: 0,
         }),
      });
   });

   it('is idempotent per (planId, scheduledFor)', async () => {
      mockTx.dcaRun.findUnique.mockResolvedValue({ id: 'existing-run' });

      const worker = new DcaExecutorWorker(client, { now: () => now });
      await worker.tick();

      expect(client.executeBuyWithAuth).not.toHaveBeenCalled();
      expect(mockTx.dcaRun.create).not.toHaveBeenCalled();
   });

   it('records skipped run with reason when budget, balance, or slippage fails', async () => {
      // Insufficient budget
      mockTx.$queryRaw.mockResolvedValue([
         { ...basePlan, budgetRemaining: 5_000_000n },
      ]);
      const worker = new DcaExecutorWorker(client, { now: () => now });
      await worker.tick();
      expect(mockTx.dcaRun.create).toHaveBeenCalledWith({
         data: expect.objectContaining({
            status: 'skipped',
            reason: 'insufficient_budget',
         }),
      });

      // Insufficient balance
      jest.clearAllMocks();
      mockTx.dcaRun.findUnique.mockResolvedValue(null);
      mockTx.$queryRaw.mockResolvedValue([{ ...basePlan }]);
      client.getWalletBalance.mockResolvedValue(1_000_000n);
      await worker.tick();
      expect(mockTx.dcaRun.create).toHaveBeenCalledWith({
         data: expect.objectContaining({
            status: 'skipped',
            reason: 'insufficient_balance',
         }),
      });

      // Slippage exceeded
      jest.clearAllMocks();
      mockTx.dcaRun.findUnique.mockResolvedValue(null);
      mockTx.$queryRaw.mockResolvedValue([{ ...basePlan }]);
      client.getWalletBalance.mockResolvedValue(100_000_000n);
      client.getSlippageBps.mockResolvedValue(250);
      await worker.tick();
      expect(mockTx.dcaRun.create).toHaveBeenCalledWith({
         data: expect.objectContaining({
            status: 'skipped',
            reason: 'slippage_exceeded',
         }),
      });
   });

   it('pauses plan after 3 consecutive failures and emits dca.paused event', async () => {
      const pausedListener = jest.fn();
      dcaEventEmitter.on('dca.paused', pausedListener);

      mockTx.$queryRaw.mockResolvedValue([
         { ...basePlan, consecutiveFailures: 2 },
      ]);
      client.executeBuyWithAuth.mockRejectedValue(new Error('tx_failed'));

      const worker = new DcaExecutorWorker(client, { now: () => now });
      await worker.tick();

      expect(mockTx.dcaRun.create).toHaveBeenCalledWith({
         data: expect.objectContaining({
            status: 'failed',
            reason: 'tx_failed',
         }),
      });
      expect(mockTx.dcaPlan.update).toHaveBeenCalledWith({
         where: { id: 'plan-1' },
         data: expect.objectContaining({
            consecutiveFailures: 3,
            status: 'paused',
         }),
      });
      expect(pausedListener).toHaveBeenCalledWith(
         expect.objectContaining({
            planId: 'plan-1',
            consecutiveFailures: 3,
         })
      );

      dcaEventEmitter.off('dca.paused', pausedListener);
   });
});
