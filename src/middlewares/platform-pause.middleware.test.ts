// src/middlewares/platform-pause.middleware.test.ts

jest.mock('../utils/redis.utils', () => ({
   cacheGet: jest.fn().mockResolvedValue(null),
   cacheGetJson: jest.fn().mockResolvedValue(null),
   cacheSetJson: jest.fn().mockResolvedValue(undefined),
   cacheSetRaw: jest.fn().mockResolvedValue(undefined),
   cacheInvalidate: jest.fn().mockResolvedValue(undefined),
}));

import type { NextFunction, Request, Response } from 'express';
import {
   PLATFORM_PAUSED_MESSAGE,
   KEY_PAUSED_MESSAGE,
   platformPauseGuard,
   resolveTradeKeyIds,
} from './platform-pause.middleware';
import {
   clearPlatformPaused,
   resetPlatformPauseCache,
   setKeyPaused,
   setPlatformPaused,
} from '../modules/platform/platform-pause.service';

function mockRes() {
   const res = {
      setHeader: jest.fn(),
      status: jest.fn(),
      json: jest.fn(),
   } as unknown as Response;
   (res.status as jest.Mock).mockReturnValue(res);
   return res;
}

function mockReq(overrides: Partial<Request> = {}): Request {
   return {
      params: {},
      body: {},
      ...overrides,
   } as unknown as Request;
}

beforeEach(() => {
   resetPlatformPauseCache();
   jest.clearAllMocks();
});

describe('resolveTradeKeyIds', () => {
   it('collects URL params and multi-buy legs', () => {
      const ids = resolveTradeKeyIds(
         mockReq({
            params: { id: 'key-1' } as never,
            body: { legs: [{ creator: 'key-2' }, { creator: 'key-3' }] },
         })
      );
      expect(ids.sort()).toEqual(['key-1', 'key-2', 'key-3']);
   });
});

describe('platformPauseGuard', () => {
   it('rejects every trade with 503 while the platform is paused', async () => {
      await setPlatformPaused('GADMIN', new Date('2026-09-28T12:00:00.000Z'));
      const req = mockReq({ params: { id: 'key-1' } as never });
      const res = mockRes();
      const next = jest.fn() as NextFunction;

      await platformPauseGuard()(req, res, next);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
         expect.objectContaining({
            success: false,
            error: expect.objectContaining({
               code: 'SERVICE_UNAVAILABLE',
               message: PLATFORM_PAUSED_MESSAGE,
            }),
         })
      );
      expect(next).not.toHaveBeenCalled();
   });

   it('passes through when nothing is paused', async () => {
      const res = mockRes();
      const next = jest.fn() as NextFunction;

      await platformPauseGuard()(
         mockReq({ params: { id: 'key-1' } as never }),
         res,
         next
      );

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
   });

   it('blocks only the paused key', async () => {
      await setKeyPaused('key-1', 'GADMIN');

      const blockedRes = mockRes();
      const blockedNext = jest.fn() as NextFunction;
      await platformPauseGuard()(
         mockReq({ params: { id: 'key-1' } as never }),
         blockedRes,
         blockedNext
      );
      expect(blockedRes.status).toHaveBeenCalledWith(503);
      expect(blockedRes.json).toHaveBeenCalledWith(
         expect.objectContaining({
            error: expect.objectContaining({
               code: 'SERVICE_UNAVAILABLE',
               message: KEY_PAUSED_MESSAGE,
            }),
         })
      );
      expect(blockedNext).not.toHaveBeenCalled();

      const openRes = mockRes();
      const openNext = jest.fn() as NextFunction;
      await platformPauseGuard()(
         mockReq({ params: { id: 'key-2' } as never }),
         openRes,
         openNext
      );
      expect(openNext).toHaveBeenCalledTimes(1);
      expect(openRes.status).not.toHaveBeenCalled();
   });

   it('allows trades again after the platform resumes', async () => {
      await setPlatformPaused(null);
      await clearPlatformPaused();

      const res = mockRes();
      const next = jest.fn() as NextFunction;
      await platformPauseGuard()(mockReq(), res, next);

      expect(next).toHaveBeenCalledTimes(1);
   });
});
