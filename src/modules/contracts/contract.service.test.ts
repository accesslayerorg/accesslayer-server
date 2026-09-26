import { prisma } from '../../utils/prisma.utils';
import { submitContractCall } from './contract.service';
import {
   ContractSubmitError,
} from './contract-error.utils';
import {
   CONTRACT_EVENTS,
   onContractEvent,
   removeAllContractEventListeners,
} from './contract-events.utils';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      contractTransaction: {
         create: jest.fn(),
         update: jest.fn(),
      },
   },
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
   },
}));

const mockPrisma = prisma as unknown as {
   contractTransaction: {
      create: jest.Mock;
      update: jest.Mock;
   };
};

function makeDeps(
   sendTransaction: jest.Mock,
   overrides: { getTransaction?: jest.Mock; now?: () => number } = {}
) {
   let currentTime = 0;
   const pollCalls: number[] = [];
   const getTransaction =
      overrides.getTransaction ??
      jest.fn().mockResolvedValue({ status: 'SUCCESS', ledger: 100 });

   return {
      deps: {
         submitClient: { sendTransaction },
         statusClient: { getTransaction },
         delay: async (ms: number) => {
            currentTime += ms;
            pollCalls.push(ms);
         },
         now: overrides.now ?? (() => currentTime),
         pollIntervalMs: 5,
         pollTimeoutMs: 500,
      },
      backoffCalls: pollCalls,
   };
}

const BASE_INPUT = {
   operation: 'buy' as const,
   submitterWallet: 'GWALLET',
   transactionXdr: 'AAAAbase64xdr==',
};

beforeEach(() => {
   jest.clearAllMocks();
   removeAllContractEventListeners();
});

describe('submitContractCall — submission retry (#899)', () => {
   it('confirms a transaction accepted on first attempt', async () => {
      const sendTransaction = jest
         .fn()
         .mockResolvedValue({ hash: 'hash-ok', status: 'PENDING' });
      const { deps } = makeDeps(sendTransaction);
      mockPrisma.contractTransaction.create.mockResolvedValue({});
      mockPrisma.contractTransaction.update.mockResolvedValue({});

      const result = await submitContractCall(BASE_INPUT, deps);

      expect(result.status).toBe('CONFIRMED');
      if (result.status === 'CONFIRMED') {
         expect(result.txHash).toBe('hash-ok');
         expect(result.ledger).toBe(100);
         expect(result.attempts).toBe(1);
      }
      expect(sendTransaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.contractTransaction.create).toHaveBeenCalledWith(
         expect.objectContaining({
            data: expect.objectContaining({
               txHash: 'hash-ok',
               status: 'PENDING',
               attempts: 1,
            }),
         })
      );
   });

   it('retries transient failures up to 3 times with exponential backoff', async () => {
      const sendTransaction = jest
         .fn()
         .mockRejectedValueOnce(new Error('request timed out'))
         .mockRejectedValueOnce(new Error('ECONNRESET'))
         .mockResolvedValueOnce({ hash: 'hash-retry', status: 'PENDING' });
      const { deps, backoffCalls } = makeDeps(sendTransaction);
      mockPrisma.contractTransaction.create.mockResolvedValue({});
      mockPrisma.contractTransaction.update.mockResolvedValue({});

      // Zero jitter so delays are exactly the exponential backoff values.
      const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);

      try {
         const result = await submitContractCall(BASE_INPUT, deps);

         expect(result.status).toBe('CONFIRMED');
         expect(sendTransaction).toHaveBeenCalledTimes(3);
         // Exponential backoff: base 1000 -> attempt 0 delay 1000, attempt 1 delay 2000.
         expect(backoffCalls).toEqual([1000, 2000]);
      } finally {
         randomSpy.mockRestore();
      }
   });

   it('throws a transient ContractSubmitError after exhausting 3 attempts', async () => {
      const sendTransaction = jest
         .fn()
         .mockRejectedValue(new Error('Soroban RPC HTTP 503: overloaded'));
      const { deps } = makeDeps(sendTransaction);

      await expect(submitContractCall(BASE_INPUT, deps)).rejects.toThrow(
         ContractSubmitError
      );
      expect(sendTransaction).toHaveBeenCalledTimes(3);
   });

   it('returns user errors immediately without any retry', async () => {
      const sendTransaction = jest
         .fn()
         .mockRejectedValue(new Error('tx_bad_auth: signature mismatch'));
      const { deps } = makeDeps(sendTransaction);

      await expect(submitContractCall(BASE_INPUT, deps)).rejects.toThrow(
         /tx_bad_auth/
      );
      expect(sendTransaction).toHaveBeenCalledTimes(1);
   });

   it('does not retry when the node rejects the submission envelope', async () => {
      const sendTransaction = jest
         .fn()
         .mockResolvedValue({
            status: 'ERROR',
            errorResultXdr: 'tx_insufficient_balance',
         });
      const { deps } = makeDeps(sendTransaction);

      await expect(submitContractCall(BASE_INPUT, deps)).rejects.toThrow(
         /tx_insufficient_balance/
      );
      expect(sendTransaction).toHaveBeenCalledTimes(1);
   });
});

describe('submitContractCall — tracking and events (#899)', () => {
   it('stores the transaction hash and confirms it via polling', async () => {
      const getTransaction = jest
         .fn()
         .mockResolvedValueOnce({ status: 'NOT_FOUND' })
         .mockResolvedValueOnce({ status: 'SUCCESS', ledger: 777 });
      const sendTransaction = jest
         .fn()
         .mockResolvedValue({ hash: 'hash-track', status: 'PENDING' });
      const { deps } = makeDeps(sendTransaction, { getTransaction });
      mockPrisma.contractTransaction.create.mockResolvedValue({});
      mockPrisma.contractTransaction.update.mockResolvedValue({});

      const confirmedHandler = jest.fn();
      const failedHandler = jest.fn();
      onContractEvent(CONTRACT_EVENTS.TX_CONFIRMED, confirmedHandler);
      onContractEvent(CONTRACT_EVENTS.TX_FAILED, failedHandler);

      const result = await submitContractCall(BASE_INPUT, deps);

      expect(result.status).toBe('CONFIRMED');
      // Row created as PENDING with the hash, then updated to CONFIRMED.
      expect(mockPrisma.contractTransaction.create).toHaveBeenCalledWith(
         expect.objectContaining({
            data: expect.objectContaining({
               txHash: 'hash-track',
               status: 'PENDING',
            }),
         })
      );
      expect(mockPrisma.contractTransaction.update).toHaveBeenCalledWith(
         expect.objectContaining({
            where: { txHash: 'hash-track' },
            data: expect.objectContaining({
               status: 'CONFIRMED',
               ledger: 777,
            }),
         })
      );
      expect(confirmedHandler).toHaveBeenCalledWith(
         expect.objectContaining({
            txHash: 'hash-track',
            ledger: 777,
            operation: 'buy',
         })
      );
      expect(failedHandler).not.toHaveBeenCalled();
   });

   it('emits contract_tx_failed and persists FAILED when the tx fails on-chain', async () => {
      const getTransaction = jest
         .fn()
         .mockResolvedValue({ status: 'FAILED', ledger: 42 });
      const sendTransaction = jest
         .fn()
         .mockResolvedValue({ hash: 'hash-fail', status: 'PENDING' });
      const { deps } = makeDeps(sendTransaction, { getTransaction });
      mockPrisma.contractTransaction.create.mockResolvedValue({});
      mockPrisma.contractTransaction.update.mockResolvedValue({});

      const confirmedHandler = jest.fn();
      const failedHandler = jest.fn();
      onContractEvent(CONTRACT_EVENTS.TX_CONFIRMED, confirmedHandler);
      onContractEvent(CONTRACT_EVENTS.TX_FAILED, failedHandler);

      const result = await submitContractCall(BASE_INPUT, deps);

      expect(result).toMatchObject({
         status: 'FAILED',
         txHash: 'hash-fail',
         errorKind: 'user',
      });
      expect(mockPrisma.contractTransaction.update).toHaveBeenCalledWith(
         expect.objectContaining({
            where: { txHash: 'hash-fail' },
            data: expect.objectContaining({ status: 'FAILED' }),
         })
      );
      expect(failedHandler).toHaveBeenCalledWith(
         expect.objectContaining({
            txHash: 'hash-fail',
            errorKind: 'user',
         })
      );
      expect(confirmedHandler).not.toHaveBeenCalled();
   });

   it('emits contract_tx_failed with kind user and no hash when submission is a user error', async () => {
      const sendTransaction = jest
         .fn()
         .mockRejectedValue(new Error('tx_malformed'));
      const { deps } = makeDeps(sendTransaction);

      const failedHandler = jest.fn();
      onContractEvent(CONTRACT_EVENTS.TX_FAILED, failedHandler);

      await expect(submitContractCall(BASE_INPUT, deps)).rejects.toThrow(
         ContractSubmitError
      );

      expect(failedHandler).toHaveBeenCalledWith(
         expect.objectContaining({
            txHash: null,
            errorKind: 'user',
            attempts: 1,
         })
      );
   });

   it('emits contract_tx_failed with kind transient when retries are exhausted', async () => {
      const sendTransaction = jest
         .fn()
         .mockRejectedValue(new Error('temporarily unavailable'));
      const { deps } = makeDeps(sendTransaction);

      const failedHandler = jest.fn();
      onContractEvent(CONTRACT_EVENTS.TX_FAILED, failedHandler);

      await expect(submitContractCall(BASE_INPUT, deps)).rejects.toThrow(
         ContractSubmitError
      );

      expect(failedHandler).toHaveBeenCalledWith(
         expect.objectContaining({
            txHash: null,
            errorKind: 'transient',
            attempts: 3,
         })
      );
   });

   it('continues the flow even when tracking persistence fails', async () => {
      const sendTransaction = jest
         .fn()
         .mockResolvedValue({ hash: 'hash-dbfail', status: 'PENDING' });
      const { deps } = makeDeps(sendTransaction);
      mockPrisma.contractTransaction.create.mockRejectedValue(
         new Error('db down')
      );
      mockPrisma.contractTransaction.update.mockResolvedValue({});

      const result = await submitContractCall(BASE_INPUT, deps);
      expect(result.status).toBe('CONFIRMED');
   });
});
