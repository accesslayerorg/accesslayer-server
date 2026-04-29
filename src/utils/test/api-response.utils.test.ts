import { Response } from 'express';
import {
   sendForbidden,
   sendUnauthorized,
   ErrorCode,
} from '../api-response.utils';

describe('api-response.utils', () => {
   let mockResponse: Partial<Response>;
   let jsonMock: jest.Mock;
   let statusMock: jest.Mock;

   beforeEach(() => {
      jsonMock = jest.fn();
      statusMock = jest.fn().mockReturnValue({ json: jsonMock });
      mockResponse = {
         status: statusMock,
      };
   });

   describe('sendForbidden', () => {
      it('should send a 403 response with default message', () => {
         sendForbidden(mockResponse as Response);

         expect(statusMock).toHaveBeenCalledWith(403);
         expect(jsonMock).toHaveBeenCalledWith({
            success: false,
            error: {
               code: ErrorCode.FORBIDDEN,
               message: 'Access forbidden',
            },
         });
      });

      it('should send a 403 response with custom message and details', () => {
         const details = [{ field: 'role', message: 'Required admin role' }];
         sendForbidden(mockResponse as Response, 'Custom forbidden', details);

         expect(statusMock).toHaveBeenCalledWith(403);
         expect(jsonMock).toHaveBeenCalledWith({
            success: false,
            error: {
               code: ErrorCode.FORBIDDEN,
               message: 'Custom forbidden',
               details,
            },
         });
      });
   });

   describe('sendUnauthorized', () => {
      it('should send a 401 response with default message', () => {
         sendUnauthorized(mockResponse as Response);

         expect(statusMock).toHaveBeenCalledWith(401);
         expect(jsonMock).toHaveBeenCalledWith({
            success: false,
            error: {
               code: ErrorCode.UNAUTHORIZED,
               message: 'Unauthorized access',
            },
         });
      });
   });
});
