import { mapUnknownRouteError } from './route-error.utils';
import { ErrorCode } from '../constants/error.constants';

describe('mapUnknownRouteError()', () => {
   it('maps a vanilla Error to a 500 with the generic safe message', () => {
      const result = mapUnknownRouteError(new Error('boom'));
      expect(result.statusCode).toBe(500);
      expect(result.body.success).toBe(false);
      expect(result.body.code).toBe(ErrorCode.INTERNAL_ERROR);
      expect(result.body.message).toBe('Internal server error');
   });

   it('preserves an explicit statusCode on the error', () => {
      const err = Object.assign(new Error('nope'), { statusCode: 418 });
      const result = mapUnknownRouteError(err);
      expect(result.statusCode).toBe(418);
   });

   it('preserves an explicit status property on the error', () => {
      const err = Object.assign(new Error('nope'), { status: 502 });
      const result = mapUnknownRouteError(err);
      expect(result.statusCode).toBe(502);
   });

   it('embeds the request id when provided', () => {
      const result = mapUnknownRouteError(new Error('boom'), {
         requestId: 'req-abc-123',
      });
      expect(result.body.requestId).toBe('req-abc-123');
   });

   it('omits requestId when none provided', () => {
      const result = mapUnknownRouteError(new Error('boom'));
      expect(result.body).not.toHaveProperty('requestId');
   });

   it('hides the original message and omits debug fields by default', () => {
      const err = new Error('secret leak');
      err.stack = 'stack-trace';
      const result = mapUnknownRouteError(err);
      expect(result.body.message).toBe('Internal server error');
      expect(result.body).not.toHaveProperty('stack');
      expect(result.body).not.toHaveProperty('error');
   });

   it('exposes message, stack and raw error when includeDebug is true', () => {
      const err = new Error('debug detail');
      err.stack = 'stack-trace-here';
      const result = mapUnknownRouteError(err, {
         requestId: 'r1',
         includeDebug: true,
      });
      expect(result.body.message).toBe('debug detail');
      expect(result.body.stack).toBe('stack-trace-here');
      expect(result.body.error).toBe(err);
   });

   it('falls back to a default message when err.message is empty in debug mode', () => {
      const err = new Error('');
      const result = mapUnknownRouteError(err, { includeDebug: true });
      expect(result.body.message).toBe('Something went wrong');
   });

   it('handles non-Error throwables (string, plain object) without crashing', () => {
      expect(mapUnknownRouteError('oops').statusCode).toBe(500);
      expect(mapUnknownRouteError({ statusCode: 503 }).statusCode).toBe(503);
      expect(mapUnknownRouteError(null).statusCode).toBe(500);
      expect(mapUnknownRouteError(undefined).statusCode).toBe(500);
   });

   it('uses errorCode from the error when present', () => {
      const err = Object.assign(new Error('x'), {
         errorCode: ErrorCode.RATE_LIMIT,
      });
      const result = mapUnknownRouteError(err);
      expect(result.body.code).toBe(ErrorCode.RATE_LIMIT);
   });
});
