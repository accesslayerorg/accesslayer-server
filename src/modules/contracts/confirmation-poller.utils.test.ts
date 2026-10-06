import {
   pollForConfirmation,
   type TransactionStatusClient,
} from './confirmation-poller.utils';

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
   },
}));

function makeDeps(
   statusClient: Partial<TransactionStatusClient>,
   overrides: { timeoutMs?: number; intervalMs?: number } = {}
) {
   let currentTime = 0;
   return {
      deps: {
         statusClient: statusClient as TransactionStatusClient,
         intervalMs: overrides.intervalMs ?? 5,
         timeoutMs: overrides.timeoutMs ?? 100,
         delay: async () => {
            currentTime += 5;
         },
         now: () => currentTime,
      },
      advance: (ms: number) => {
         currentTime += ms;
      },
   };
}

describe('pollForConfirmation (#899)', () => {
   it('returns SUCCESS with ledger on confirmation', async () => {
      const { deps } = makeDeps({
         getTransaction: jest
            .fn()
            .mockResolvedValue({ status: 'SUCCESS', ledger: 1234 }),
      });

      const outcome = await pollForConfirmation('hash-1', deps);
      expect(outcome).toMatchObject({
         status: 'SUCCESS',
         ledger: 1234,
      });
   });

   it('keeps polling while status is NOT_FOUND, then confirms', async () => {
      const getTransaction = jest
         .fn()
         .mockResolvedValueOnce({ status: 'NOT_FOUND' })
         .mockResolvedValueOnce({ status: 'NOT_FOUND' })
         .mockResolvedValueOnce({ status: 'SUCCESS', ledger: 55 });
      const { deps } = makeDeps({ getTransaction });

      const outcome = await pollForConfirmation('hash-2', deps);
      expect(outcome).toMatchObject({ status: 'SUCCESS', ledger: 55 });
      expect(getTransaction).toHaveBeenCalledTimes(3);
   });

   it('returns FAILED when the transaction fails on-chain', async () => {
      const { deps } = makeDeps({
         getTransaction: jest.fn().mockResolvedValue({
            status: 'FAILED',
            ledger: 88,
         }),
      });

      const outcome = await pollForConfirmation('hash-3', deps);
      expect(outcome).toMatchObject({ status: 'FAILED', ledger: 88 });
   });

   it('returns null when the polling window elapses without resolution', async () => {
      const { deps } = makeDeps(
         {
            getTransaction: jest
               .fn()
               .mockResolvedValue({ status: 'NOT_FOUND' }),
         },
         { timeoutMs: 10, intervalMs: 5 }
      );

      const outcome = await pollForConfirmation('hash-4', deps);
      expect(outcome).toBeNull();
   });

   it('survives transient poll errors and confirms on a later poll', async () => {
      const getTransaction = jest
         .fn()
         .mockRejectedValueOnce(new Error('ECONNRESET'))
         .mockResolvedValueOnce({ status: 'SUCCESS', ledger: 99 });
      const { deps } = makeDeps({ getTransaction });

      const outcome = await pollForConfirmation('hash-5', deps);
      expect(outcome).toMatchObject({ status: 'SUCCESS', ledger: 99 });
      expect(getTransaction).toHaveBeenCalledTimes(2);
   });
});
