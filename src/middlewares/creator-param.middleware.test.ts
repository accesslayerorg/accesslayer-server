// src/middlewares/creator-param.middleware.test.ts
import { Request, Response, NextFunction } from 'express';
import { validateCreatorParam } from './creator-param.middleware';

function makeReq(params: Record<string, string> = {}): Request {
  return { params } as unknown as Request;
}

function makeRes(): Partial<Response> {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn().mockReturnValue(res);
  return res;
}

function makeNext(): jest.Mock {
  return jest.fn();
}

describe('validateCreatorParam middleware', () => {
  describe('valid params — calls next()', () => {
    it('passes a standard alphanumeric handle', () => {
      const next = makeNext();
      validateCreatorParam('creatorId')(
        makeReq({ creatorId: 'alice123' }),
        makeRes() as Response,
        next as NextFunction
      );
      expect(next).toHaveBeenCalledWith();
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('passes a UUID-style id param', () => {
      const next = makeNext();
      validateCreatorParam('id')(
        makeReq({ id: 'abc123-def456' }),
        makeRes() as Response,
        next as NextFunction
      );
      expect(next).toHaveBeenCalledWith();
    });

    it('passes a handle with underscores and hyphens', () => {
      const next = makeNext();
      validateCreatorParam('creatorId')(
        makeReq({ creatorId: 'jazz_king-99' }),
        makeRes() as Response,
        next as NextFunction
      );
      expect(next).toHaveBeenCalledWith();
    });

    it('passes a single character param', () => {
      const next = makeNext();
      validateCreatorParam('creatorId')(
        makeReq({ creatorId: 'a' }),
        makeRes() as Response,
        next as NextFunction
      );
      expect(next).toHaveBeenCalledWith();
    });
  });

  describe('invalid params — returns 400 and does not call next()', () => {
    it('rejects a missing param key', () => {
      const next = makeNext();
      const res = makeRes();
      validateCreatorParam('creatorId')(
        makeReq({}),
        res as Response,
        next as NextFunction
      );
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('rejects a param with special characters', () => {
      const next = makeNext();
      const res = makeRes();
      validateCreatorParam('creatorId')(
        makeReq({ creatorId: 'bad param!' }),
        res as Response,
        next as NextFunction
      );
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('rejects a param exceeding 128 characters', () => {
      const next = makeNext();
      const res = makeRes();
      validateCreatorParam('creatorId')(
        makeReq({ creatorId: 'a'.repeat(129) }),
        res as Response,
        next as NextFunction
      );
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('rejects a param with path traversal characters', () => {
      const next = makeNext();
      const res = makeRes();
      validateCreatorParam('creatorId')(
        makeReq({ creatorId: '../admin' }),
        res as Response,
        next as NextFunction
      );
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('rejects a param with spaces', () => {
      const next = makeNext();
      const res = makeRes();
      validateCreatorParam('creatorId')(
        makeReq({ creatorId: 'hello world' }),
        res as Response,
        next as NextFunction
      );
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('error response includes the param field name', () => {
      const next = makeNext();
      const res = makeRes();
      validateCreatorParam('creatorId')(
        makeReq({ creatorId: 'bad!' }),
        res as Response,
        next as NextFunction
      );
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.error.details[0].field).toBe('creatorId');
    });

    it('works with a different param name (id)', () => {
      const next = makeNext();
      const res = makeRes();
      validateCreatorParam('id')(
        makeReq({ id: 'bad@id' }),
        res as Response,
        next as NextFunction
      );
      expect(next).not.toHaveBeenCalled();
      const body = (res.json as jest.Mock).mock.calls[0][0];
      expect(body.error.details[0].field).toBe('id');
    });
  });
});