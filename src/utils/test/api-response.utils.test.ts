import { Response } from 'express';
import {
   sendForbidden,
   sendUnauthorized,
   buildErrorResponse,
   zodIssuesToDetails,
   ErrorCode,
} from '../api-response.utils';
import { requestContextStorage } from '../als.utils';

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

describe('buildErrorResponse', () => {
   it('returns a well-formed error body without requestId when no ALS context is active', () => {
      const body = buildErrorResponse(ErrorCode.NOT_FOUND, 'Resource not found');
      expect(body).toEqual({
         success: false,
         error: { code: ErrorCode.NOT_FOUND, message: 'Resource not found' },
      });
      expect(body).not.toHaveProperty('requestId');
   });

   it('includes requestId from ALS context when available', () => {
      let body: ReturnType<typeof buildErrorResponse> | undefined;
      requestContextStorage.run(
         { path: '/test', method: 'GET', requestId: 'req-test-123' },
         () => {
            body = buildErrorResponse(ErrorCode.VALIDATION_ERROR, 'Bad input');
         }
      );
      expect(body!.requestId).toBe('req-test-123');
   });

   it('omits requestId when ALS context has no requestId', () => {
      let body: ReturnType<typeof buildErrorResponse> | undefined;
      requestContextStorage.run(
         { path: '/test', method: 'GET' },
         () => {
            body = buildErrorResponse(ErrorCode.INTERNAL_ERROR, 'Oops');
         }
      );
      expect(body!).not.toHaveProperty('requestId');
   });

   it('includes details when provided', () => {
      const details = [{ field: 'email', message: 'Required' }];
      const body = buildErrorResponse(ErrorCode.VALIDATION_ERROR, 'Invalid', details);
      expect(body.error.details).toEqual(details);
   });

   it('omits details key when details array is empty', () => {
      const body = buildErrorResponse(ErrorCode.VALIDATION_ERROR, 'Invalid', []);
      expect(body.error).not.toHaveProperty('details');
   });

   it('requestId in response matches the requestId in the server log context', () => {
      // Simulates the traceability requirement: the same requestId that appears
      // in the error response body is the one stored in the ALS context (which
      // the logger also reads), so log entries and client responses are correlated.
      const expectedRequestId = 'req-correlation-456';
      let capturedRequestId: string | undefined;
      let body: ReturnType<typeof buildErrorResponse> | undefined;

      requestContextStorage.run(
         { path: '/api/v1/creators', method: 'GET', requestId: expectedRequestId },
         () => {
            capturedRequestId = requestContextStorage.getStore()?.requestId;
            body = buildErrorResponse(ErrorCode.INTERNAL_ERROR, 'Server error');
         }
      );

      expect(body!.requestId).toBe(expectedRequestId);
      expect(capturedRequestId).toBe(expectedRequestId);
      expect(body!.requestId).toBe(capturedRequestId);
   });
});

describe('zodIssuesToDetails', () => {
   it('maps a single issue to a details entry', () => {
      const result = zodIssuesToDetails([
         { path: ['email'], message: 'Invalid email', code: 'invalid_string' } as any,
      ]);
      expect(result).toEqual([{ field: 'email', message: 'Invalid email' }]);
   });

   it('joins nested paths with a dot', () => {
      const result = zodIssuesToDetails([
         { path: ['address', 'city'], message: 'Required', code: 'invalid_type' } as any,
      ]);
      expect(result).toEqual([{ field: 'address.city', message: 'Required' }]);
   });

   it('produces an empty string field for root-level issues', () => {
      const result = zodIssuesToDetails([
         { path: [], message: 'Input must be an object', code: 'invalid_type' } as any,
      ]);
      expect(result).toEqual([{ field: '', message: 'Input must be an object' }]);
   });

   it('returns an empty array for an empty issues list', () => {
      expect(zodIssuesToDetails([])).toEqual([]);
   });

   it('maps multiple issues preserving order', () => {
      const result = zodIssuesToDetails([
         { path: ['name'], message: 'Required', code: 'invalid_type' } as any,
         { path: ['age'], message: 'Must be a number', code: 'invalid_type' } as any,
      ]);
      expect(result).toEqual([
         { field: 'name', message: 'Required' },
         { field: 'age', message: 'Must be a number' },
      ]);
   });
});
