// src/modules/contracts/ledger-depth-gate.utils.test.ts
// Unit tests for #724 — buy/sell confirmations are gated on confirmed
// ledger depth ≥ 2.

import {
   CONFIRMED_LEDGER_DEPTH,
   waitForLedgerDepth,
} from './ledger-depth-gate.utils';
import { logger } from '../../utils/logger.utils';
import { submitContractCall } from './contract.service';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      contractTransaction: {
         create: jest.fn().mockResolvedValue({}),
         update: jest.fn().mockResolvedValue({}),
      },
   },
}));

function makeGateDeps(
   getTransaction: jest.Mock,
   overrides: { intervalMs?: number; timeoutMs?: number } = {}
) {
   let currentTime = 0;
   const delays: number[] = [];
   return {
      deps: {
         statusClient: { getTransaction },
         txHash: 'tx-hash-1',
         intervalMs: overrides.intervalMs ?? 5,
         timeoutMs: overrides.timeoutMs ?? 500,
         delay: async (ms: number) => {
            delays.push(ms);
            currentTime += ms;
         },
         now: () => currentTime,
      },
      delays,
   };
}

describe('waitForLedgerDepth (#724)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('requires a depth of 2 ledgers', () => {
      expect(CONFIRMED_LEDGER_DEPTH).toBe(2);
   });

   it('resolves immediately when the ledger is already 2 deep', async () => {
      const getTransaction = jest
         .fn()
         .mockResolvedValue({ status: 'SUCCESS', ledger: 100, latestLedger: 102 });
      const { deps } = makeGateDeps(getTransaction);

      const result = await waitForLedgerDepth(100, deps);

      expect(result).toEqual({ depthConfirmed: true, latestLedger: 102 });
      expect(getTransaction).toHaveBeenCalledTimes(1);
   });

   it('keeps polling until the head advances to the required depth', async () => {
      const heads = [100, 101, 102];
      let call = 0;
      const getTransaction = jest.fn().mockImplementation(async () => ({
         status: 'SUCCESS',
         ledger: 100,
         latestLedger: heads[Math.min(call++, heads.length - 1)],
      }));
      const { deps, delays } = makeGateDeps(getTransaction);

      const result = await waitForLedgerDepth(100, deps);

      expect(result.depthConfirmed).toBe(true);
      expect(result.latestLedger).toBe(102);
      // Head was polled at least twice and waited between polls.
      expect(getTransaction.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(delays.length).toBeGreaterThanOrEqual(2);
   });

   it('reports depthConfirmed=false when the budget is exhausted', async () => {
      const warnSpy = jest.spyOn(logger, 'warn');
      const getTransaction = jest
         .fn()
         .mockResolvedValue({ status: 'SUCCESS', ledger: 100, latestLedger: 100 });
      const { deps } = makeGateDeps(getTransaction, { timeoutMs: 30 });

      const result = await waitForLedgerDepth(100, deps);

      expect(result.depthConfirmed).toBe(false);
      expect(result.latestLedger).toBe(100);
      expect(warnSpy).toHaveBeenCalledWith(
         expect.objectContaining({
            tx_ledger: 100,
            latest_ledger: 100,
            required_depth: 2,
         }),
         'Ledger depth gate timed out before the required confirmation depth'
      );
      warnSpy.mockRestore();
   });

   it('retries transient RPC failures instead of throwing', async () => {
      let call = 0;
      const getTransaction = jest.fn().mockImplementation(async () => {
         call += 1;
         if (call === 1) {
            throw new Error('rpc unavailable');
         }
         return { status: 'SUCCESS', ledger: 100, latestLedger: 103 };
      });
      const { deps } = makeGateDeps(getTransaction);

      const result = await waitForLedgerDepth(100, deps);

      expect(result.depthConfirmed).toBe(true);
      expect(result.latestLedger).toBe(103);
   });

   it('treats a missing latestLedger as "not deep enough yet"', async () => {
      const getTransaction = jest
         .fn()
         .mockResolvedValue({ status: 'SUCCESS', ledger: 100 });
      const { deps } = makeGateDeps(getTransaction, { timeoutMs: 20 });

      const result = await waitForLedgerDepth(100, deps);

      expect(result.depthConfirmed).toBe(false);
   });
});

describe('submitContractCall ledger-depth gate (#724)', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('withholds the CONFIRMED result until the including ledger is 2 deep', async () => {
      const sendTransaction = jest
         .fn()
         .mockResolvedValue({ hash: 'hash-gated', status: 'PENDING' });

      // Confirmation lands at ledger 100; the head lags at 100/101 and only
      // reaches 102 after several polls.
      const heads = [100, 100, 101, 102];
      let call = 0;
      const getTransaction = jest.fn().mockImplementation(async () => ({
         status: 'SUCCESS',
         ledger: 100,
         latestLedger: heads[Math.min(call++, heads.length - 1)],
      }));

      let currentTime = 0;
      const deps = {
         submitClient: { sendTransaction },
         statusClient: { getTransaction },
         delay: async (ms: number) => {
            currentTime += ms;
         },
         now: () => currentTime,
         pollIntervalMs: 5,
         pollTimeoutMs: 500,
      };

      const result = await submitContractCall(
         {
            operation: 'buy' as const,
            submitterWallet: 'GWALLET',
            transactionXdr: 'AAAAbase64xdr==',
         },
         deps
      );

      expect(result.status).toBe('CONFIRMED');
      // At least one confirmation poll plus the depth-gate polls.
      expect(getTransaction.mock.calls.length).toBeGreaterThan(1);
   });
});
