import {
   CONTRACT_EVENTS,
   onContractEvent,
   emitContractTxConfirmed,
   emitContractTxFailed,
   removeAllContractEventListeners,
} from './contract-events.utils';

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
   },
}));

beforeEach(() => {
   removeAllContractEventListeners();
});

describe('contract events (#899)', () => {
   it('delives confirmation payloads to subscribers', () => {
      const handler = jest.fn();
      const unsub = onContractEvent(CONTRACT_EVENTS.TX_CONFIRMED, handler);

      emitContractTxConfirmed({
         operation: 'buy',
         submitterWallet: 'GABC',
         txHash: 'hash-1',
         ledger: 42,
         attempts: 1,
      });

      expect(handler).toHaveBeenCalledWith(
         expect.objectContaining({
            operation: 'buy',
            txHash: 'hash-1',
            ledger: 42,
         })
      );
      unsub();
   });

   it('delivers failure payloads with the error kind', () => {
      const handler = jest.fn();
      onContractEvent(CONTRACT_EVENTS.TX_FAILED, handler);

      emitContractTxFailed({
         operation: 'stake',
         submitterWallet: 'GDEF',
         txHash: null,
         errorKind: 'user',
         lastError: 'tx_bad_auth',
         attempts: 1,
      });

      expect(handler).toHaveBeenCalledWith(
         expect.objectContaining({
            operation: 'stake',
            errorKind: 'user',
            txHash: null,
         })
      );
   });

   it('unsubscribes via the returned function', () => {
      const handler = jest.fn();
      const unsub = onContractEvent(CONTRACT_EVENTS.TX_CONFIRMED, handler);
      unsub();

      emitContractTxConfirmed({
         operation: 'claim',
         submitterWallet: 'GXYZ',
         txHash: 'hash-2',
         ledger: 7,
         attempts: 2,
      });

      expect(handler).not.toHaveBeenCalled();
   });

   it('does not cross-deliver between event types', () => {
      const confirmed = jest.fn();
      const failed = jest.fn();
      onContractEvent(CONTRACT_EVENTS.TX_CONFIRMED, confirmed);
      onContractEvent(CONTRACT_EVENTS.TX_FAILED, failed);

      emitContractTxConfirmed({
         operation: 'sell',
         submitterWallet: 'G1',
         txHash: 'hash-3',
         ledger: 9,
         attempts: 1,
      });

      expect(confirmed).toHaveBeenCalledTimes(1);
      expect(failed).not.toHaveBeenCalled();
   });

   it('emission never throws even if a handler throws', () => {
      onContractEvent(CONTRACT_EVENTS.TX_CONFIRMED, () => {
         throw new Error('handler bug');
      });

      expect(() =>
         emitContractTxConfirmed({
            operation: 'buy',
            submitterWallet: 'G2',
            txHash: 'hash-4',
            ledger: 1,
            attempts: 1,
         })
      ).not.toThrow();
   });
});
