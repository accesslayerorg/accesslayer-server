import { buildErrorContext } from './error-context.utils';
import { ErrorCode } from '../constants/error.constants';

describe('buildErrorContext', () => {
   it('produces a consistent shape from a plain Error', () => {
      const ctx = buildErrorContext(new Error('boom'), {
         requestId: 'req-1',
      });

      expect(ctx).toMatchObject({
         name: 'Error',
         message: 'boom',
         code: ErrorCode.INTERNAL_ERROR,
         requestId: 'req-1',
      });
      expect(typeof ctx.timestamp).toBe('string');
   });

   it('normalizes a Prisma error code (P*) to DATABASE_ERROR', () => {
      const prismaErr = Object.assign(new Error('unique'), {
         name: 'PrismaClientKnownRequestError',
         code: 'P2002',
      });
      expect(buildErrorContext(prismaErr).code).toBe(ErrorCode.PRISMA_ERROR);
   });

   it('maps Zod and JWT errors by name', () => {
      expect(buildErrorContext({ name: 'ZodError', message: 'x' }).code).toBe(
         ErrorCode.VALIDATION_ERROR
      );
      expect(
         buildErrorContext({ name: 'TokenExpiredError', message: 'x' }).code
      ).toBe(ErrorCode.JWT_ERROR);
   });

   it('honours an explicit errorCode when it is a known code', () => {
      expect(
         buildErrorContext({ errorCode: ErrorCode.NOT_FOUND, message: 'x' })
            .code
      ).toBe(ErrorCode.NOT_FOUND);
   });

   it('handles non-Error values (string) without throwing', () => {
      const ctx = buildErrorContext('just a string');
      expect(ctx.message).toBe('just a string');
      expect(ctx.code).toBe(ErrorCode.INTERNAL_ERROR);
   });

   it('omits the stack unless includeStack is set', () => {
      const err = new Error('boom');
      expect(buildErrorContext(err).stack).toBeUndefined();
      expect(
         buildErrorContext(err, { includeStack: true }).stack
      ).toBeDefined();
   });
});
