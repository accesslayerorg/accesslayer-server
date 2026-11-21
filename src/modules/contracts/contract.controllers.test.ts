import type { Response } from 'express';
import { httpSubmitContractCall } from './contract.controllers';
import * as contractService from './contract.service';

jest.mock('./contract.service');
jest.mock('../../utils/logger.utils', () => ({
   logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockService = contractService as jest.Mocked<typeof contractService>;

function createMockResponse() {
   const res: Partial<Response> = {};
   res.status = jest.fn().mockReturnValue(res);
   res.json = jest.fn().mockReturnValue(res);
   res.setHeader = jest.fn().mockReturnValue(res);
   return res as Response;
}

function makeRequest(body: unknown, wallet?: string) {
   return {
      body,
      requestId: 'req-1',
      ...(wallet ? { wallet } : {}),
   } as any;
}

const VALID_BODY = {
   operation: 'buy',
   submitter_wallet: 'GWALLET',
   transaction_xdr: 'AAAAbase64xdr==',
};

beforeEach(() => {
   jest.clearAllMocks();
});

describe('httpSubmitContractCall (#899)', () => {
   it('returns 400 validation error for a malformed body', async () => {
      const res = createMockResponse();
      await httpSubmitContractCall(
         makeRequest({ operation: 'nope' }),
         res,
         jest.fn()
      );

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
         expect.objectContaining({ success: false })
      );
      expect(mockService.submitContractCall).not.toHaveBeenCalled();
   });

   it('routes a valid submission through the service and returns 200', async () => {
      mockService.submitContractCall.mockResolvedValue({
         status: 'CONFIRMED',
         txHash: 'hash-1',
         ledger: 10,
         attempts: 1,
      });
      const res = createMockResponse();

      await httpSubmitContractCall(makeRequest(VALID_BODY), res, jest.fn());

      expect(mockService.submitContractCall).toHaveBeenCalledWith(
         {
            operation: 'buy',
            submitterWallet: 'GWALLET',
            transactionXdr: 'AAAAbase64xdr==',
         },
         {} // default deps
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith(
         expect.objectContaining({
            success: true,
            data: expect.objectContaining({ status: 'CONFIRMED' }),
         })
      );
   });

   it('maps user submit errors to 400', async () => {
      mockService.submitContractCall.mockRejectedValue(
         Object.assign(
            Object.create(contractService.ContractSubmitError.prototype),
            {
               name: 'ContractSubmitError',
               kind: 'user',
               message: 'tx_bad_auth',
               attempts: 1,
               txHash: null,
            }
         )
      );
      const res = createMockResponse();

      await httpSubmitContractCall(makeRequest(VALID_BODY), res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(400);
   });

   it('maps transient exhaustion to 503', async () => {
      mockService.submitContractCall.mockRejectedValue(
         Object.assign(
            Object.create(contractService.ContractSubmitError.prototype),
            {
               name: 'ContractSubmitError',
               kind: 'transient',
               message: 'Soroban RPC HTTP 503',
               attempts: 3,
               txHash: null,
            }
         )
      );
      const res = createMockResponse();

      await httpSubmitContractCall(makeRequest(VALID_BODY), res, jest.fn());

      expect(res.status).toHaveBeenCalledWith(503);
   });

   it('forwards unexpected errors to the express error handler', async () => {
      mockService.submitContractCall.mockRejectedValue(
        new Error('boom')
      );
      const res = createMockResponse();
      const next = jest.fn();

      await httpSubmitContractCall(makeRequest(VALID_BODY), res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
   });
});
