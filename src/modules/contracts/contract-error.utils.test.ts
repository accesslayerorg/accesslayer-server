import {
   classifyContractError,
   ContractSubmitError,
   ContractConfirmationTimeoutError,
} from './contract-error.utils';

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
   },
}));

describe('classifyContractError (#899)', () => {
   it('classifies signature failures as user errors', () => {
      expect(classifyContractError(new Error('tx_bad_auth: bad signature')))
         .toBe('user');
   });

   it('classifies insufficient balance as a user error', () => {
      expect(classifyContractError(new Error('tx_insufficient_balance')))
         .toBe('user');
   });

   it('classifies contract reverts as user errors', () => {
      expect(
         classifyContractError(
            new Error('Error(Contract, #1): unauthorized access reverted')
         )
      ).toBe('user');
   });

   it('classifies expired transactions as user errors (retry cannot fix time bounds)', () => {
      expect(classifyContractError(new Error('tx_too_late'))).toBe('user');
   });

   it('classifies JSON-RPC method errors as user errors regardless of message', () => {
      const rpcError = new Error('Soroban RPC error -32602: malformed XDR');
      rpcError.name = 'SorobanRpcMethodError';
      expect(classifyContractError(rpcError)).toBe('user');
   });

   it('classifies timeouts as transient', () => {
      expect(classifyContractError(new Error('request timed out')))
         .toBe('transient');
   });

   it('classifies HTTP 503 as transient', () => {
      expect(
         classifyContractError(new Error('Soroban RPC HTTP 503: overloaded'))
      ).toBe('transient');
   });

   it('classifies connection resets as transient', () => {
      expect(classifyContractError(new Error('connect ECONNRESET')))
         .toBe('transient');
   });

   it('classifies abort errors (fetch timeout) as transient', () => {
      const abort = new Error('This operation was aborted');
      abort.name = 'AbortError';
      expect(classifyContractError(abort)).toBe('transient');
   });

   it('classifies SorobanRpcHttpError as transient by error name', () => {
      const httpError = new Error('opaque failure text');
      httpError.name = 'SorobanRpcHttpError';
      expect(classifyContractError(httpError)).toBe('transient');
   });

   it('ignores XDR blobs embedded in the message when classifying', () => {
      // A long base64 blob containing "unauthorized" as a substring accident
      // is sanitized away; the remaining text has no markers so the default
      // (transient) applies.
      const blob = Buffer.from('unauthorized'.repeat(20)).toString('base64');
      expect(classifyContractError(new Error(`submit failed: ${blob}`)))
         .toBe('transient');
   });

   it('defaults non-Error values to transient', () => {
      expect(classifyContractError('some string failure')).toBe('transient');
      expect(classifyContractError(undefined)).toBe('transient');
   });
});

describe('contract error types', () => {
   it('ContractSubmitError carries kind, attempts, and txHash', () => {
      const err = new ContractSubmitError(
         'user',
         'tx_bad_auth',
         1,
         null
      );
      expect(err.kind).toBe('user');
      expect(err.attempts).toBe(1);
      expect(err.txHash).toBeNull();
      expect(err.name).toBe('ContractSubmitError');
   });

   it('ContractConfirmationTimeoutError carries the hash', () => {
      const err = new ContractConfirmationTimeoutError('abc123', 1);
      expect(err.txHash).toBe('abc123');
      expect(err.message).toContain('abc123');
      expect(err.name).toBe('ContractConfirmationTimeoutError');
   });
});
