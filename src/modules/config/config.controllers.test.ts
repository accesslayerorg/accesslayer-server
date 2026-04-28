// src/modules/config/config.controllers.test.ts
import { Request, Response } from 'express';
import { httpGetProtocolConfig } from './config.controllers';

jest.mock('../../config', () => ({
   envConfig: { MODE: 'development' },
}));

describe('httpGetProtocolConfig', () => {
   let mockRequest: Partial<Request>;
   let mockResponse: Partial<Response>;
   let jsonMock: jest.Mock;
   let statusMock: jest.Mock;

   beforeEach(() => {
      jsonMock = jest.fn();
      statusMock = jest.fn().mockReturnValue({ json: jsonMock });
      mockRequest = {};
      mockResponse = { status: statusMock };
   });

   it('returns 200 with success envelope', () => {
      httpGetProtocolConfig(mockRequest as Request, mockResponse as Response);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
         expect.objectContaining({ success: true })
      );
   });

   it('includes fees object with bps fields', () => {
      httpGetProtocolConfig(mockRequest as Request, mockResponse as Response);

      const payload = jsonMock.mock.calls[0][0];
      const { fees } = payload.data;

      expect(fees).toBeDefined();
      expect(typeof fees.platformFeeBps).toBe('number');
      expect(typeof fees.maxCreatorRoyaltyBps).toBe('number');
      expect(typeof fees.bpsDenominator).toBe('number');
   });

   it('bps fields are within valid range [0, 10000]', () => {
      httpGetProtocolConfig(mockRequest as Request, mockResponse as Response);

      const { fees } = jsonMock.mock.calls[0][0].data;

      expect(fees.platformFeeBps).toBeGreaterThanOrEqual(0);
      expect(fees.platformFeeBps).toBeLessThanOrEqual(10000);

      expect(fees.maxCreatorRoyaltyBps).toBeGreaterThanOrEqual(0);
      expect(fees.maxCreatorRoyaltyBps).toBeLessThanOrEqual(10000);
   });

   it('bpsDenominator is always 10000', () => {
      httpGetProtocolConfig(mockRequest as Request, mockResponse as Response);

      const { fees } = jsonMock.mock.calls[0][0].data;

      expect(fees.bpsDenominator).toBe(10000);
   });

   it('platformFeeBps converts correctly to percentage via bpsDenominator', () => {
      httpGetProtocolConfig(mockRequest as Request, mockResponse as Response);

      const { fees } = jsonMock.mock.calls[0][0].data;
      const percent = (fees.platformFeeBps / fees.bpsDenominator) * 100;

      expect(percent).toBe(2.5);
   });

   it('sets network to testnet in development', () => {
      httpGetProtocolConfig(mockRequest as Request, mockResponse as Response);

      const { network } = jsonMock.mock.calls[0][0].data;
      expect(network).toBe('testnet');
   });
});
