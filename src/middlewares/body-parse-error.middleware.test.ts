import { Request, Response, NextFunction } from 'express';
import { bodyParseErrorMiddleware } from './body-parse-error.middleware';
import { logger } from '../utils/logger.utils';

jest.mock('../utils/logger.utils', () => ({
  logger: { error: jest.fn() },
}));

jest.mock('../utils/client-ip.utils', () => ({
  getClientIp: jest.fn(() => '10.0.0.1'),
}));

function makeReq(method: string, url = '/api/v1/resource'): Request {
  return {
    method,
    originalUrl: url,
    url,
    requestId: 'req-test-id',
    socket: { remoteAddress: '127.0.0.1' },
    headers: {},
  } as unknown as Request;
}

function makeRes(): Partial<Response> {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function makeSyntaxError(): SyntaxError & { body: string } {
  const err = new SyntaxError('Unexpected token } in JSON') as SyntaxError & { body: string };
  err.body = 'raw body';
  return err;
}

function makeEntityTooLargeError() {
  return Object.assign(new Error('request entity too large'), {
    type: 'entity.too.large',
    status: 413,
    limit: 10 * 1024 * 1024,
  });
}

describe('bodyParseErrorMiddleware', () => {
  let next: jest.Mock;

  beforeEach(() => {
    next = jest.fn();
    jest.clearAllMocks();
  });

  describe('malformed JSON on mutation methods', () => {
    const MUTATION_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

    it.each(MUTATION_METHODS)(
      'logs error and returns 400 for %s with invalid JSON',
      (method) => {
        const err = makeSyntaxError();
        const req = makeReq(method);
        const res = makeRes();

        bodyParseErrorMiddleware(err, req, res as Response, next as NextFunction);

        expect(logger.error).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'body_parse_failure',
            method,
            path: '/api/v1/resource',
            requestId: 'req-test-id',
            errorType: 'invalid_json',
          })
        );
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ success: false, message: 'Invalid JSON in request body' })
        );
        expect(next).not.toHaveBeenCalled();
      }
    );

    it('does not include raw body in the log', () => {
      const err = makeSyntaxError();
      const req = makeReq('POST');
      const res = makeRes();

      bodyParseErrorMiddleware(err, req, res as Response, next as NextFunction);

      const logCall = (logger.error as jest.Mock).mock.calls[0][0];
      expect(logCall).not.toHaveProperty('body');
      expect(logCall).not.toHaveProperty('rawBody');
    });

    it('logs and returns 413 for entity.too.large on mutation', () => {
      const err = makeEntityTooLargeError();
      const req = makeReq('POST');
      const res = makeRes();

      bodyParseErrorMiddleware(err, req, res as Response, next as NextFunction);

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ errorType: 'entity.too.large' })
      );
      expect(res.status).toHaveBeenCalledWith(413);
    });
  });

  describe('non-mutation methods', () => {
    it('calls next() for GET with a SyntaxError (not a mutation)', () => {
      const err = makeSyntaxError();
      const req = makeReq('GET');
      const res = makeRes();

      bodyParseErrorMiddleware(err, req, res as Response, next as NextFunction);

      expect(next).toHaveBeenCalledWith(err);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('calls next() for HEAD with a SyntaxError', () => {
      const err = makeSyntaxError();
      const req = makeReq('HEAD');
      const res = makeRes();

      bodyParseErrorMiddleware(err, req, res as Response, next as NextFunction);

      expect(next).toHaveBeenCalledWith(err);
    });
  });

  describe('non-parse errors', () => {
    it('calls next() for a generic Error on a mutation method', () => {
      const err = new Error('Something else entirely');
      const req = makeReq('POST');
      const res = makeRes();

      bodyParseErrorMiddleware(err, req, res as Response, next as NextFunction);

      expect(next).toHaveBeenCalledWith(err);
      expect(logger.error).not.toHaveBeenCalled();
    });

    it('calls next() for an ApiError on a mutation method', () => {
      const err = Object.assign(new Error('Not found'), { statusCode: 404 });
      const req = makeReq('PUT');
      const res = makeRes();

      bodyParseErrorMiddleware(err, req, res as Response, next as NextFunction);

      expect(next).toHaveBeenCalledWith(err);
    });
  });

  describe('client response behaviour unchanged', () => {
    it('returns 400 JSON with success:false and does not call next', () => {
      const err = makeSyntaxError();
      const req = makeReq('POST');
      const res = makeRes();

      bodyParseErrorMiddleware(err, req, res as Response, next as NextFunction);

      expect(res.status).toHaveBeenCalledWith(400);
      expect((res.json as jest.Mock).mock.calls[0][0]).toMatchObject({
        success: false,
      });
      expect(next).not.toHaveBeenCalled();
    });
  });
});
