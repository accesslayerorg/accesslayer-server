// src/middlewares/__tests__/co-creator-permission.middleware.test.ts
import { Request, Response, NextFunction } from 'express';

let cacheStore = new Map<string, any>();

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(async (key: string) => cacheStore.get(key) ?? null),
   cacheSetJson: jest.fn(async (key: string, val: any) => {
      cacheStore.set(key, val);
   }),
   cacheInvalidate: jest.fn(async (key: string) => {
      cacheStore.delete(key);
   }),
}));

const prismaMock = {
   creatorProfile: {
      findUnique: jest.fn(),
   },
   keyCoCreator: {
      findFirst: jest.fn(),
   },
};

jest.mock('../../utils/prisma.utils', () => ({
   prisma: prismaMock,
}));

import {
   validateCoCreatorPermission,
} from '../co-creator-permission.middleware';

function mockReqRes(params: any = {}, headers: any = {}, user: any = null) {
   const req = {
      params,
      headers,
      user,
   } as unknown as Request;

   const jsonMock = jest.fn();
   const statusMock = jest.fn(() => ({ json: jsonMock }));
   const res = {
      status: statusMock,
      json: jsonMock,
   } as unknown as Response;

   const next = jest.fn() as NextFunction;

   return { req, res, next, statusMock, jsonMock };
}

describe('co-creator-permission.middleware', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      cacheStore.clear();
   });

   it('bypasses check when caller is primary creator', async () => {
      prismaMock.creatorProfile.findUnique.mockResolvedValueOnce({
         id: 'key-1',
         userId: 'PRIMARY_WALLET',
         handle: 'primary_handle',
      });

      const middleware = validateCoCreatorPermission('ADMIN');
      const { req, res, next } = mockReqRes({ keyId: 'key-1' }, {}, { wallet: 'PRIMARY_WALLET' });

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
   });

   it('allows ADMIN role on any action endpoint', async () => {
      prismaMock.creatorProfile.findUnique.mockResolvedValueOnce({
         id: 'key-1',
         userId: 'PRIMARY_WALLET',
      });
      prismaMock.keyCoCreator.findFirst.mockResolvedValueOnce({
         role: 'ADMIN',
      });

      const middleware = validateCoCreatorPermission('REVENUE');
      const { req, res, next } = mockReqRes({ keyId: 'key-1' }, {}, { wallet: 'ADMIN_WALLET' });

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
   });

   it('allows CONTENT role on CONTENT/announcement endpoint', async () => {
      prismaMock.creatorProfile.findUnique.mockResolvedValueOnce({
         id: 'key-1',
         userId: 'PRIMARY_WALLET',
      });
      prismaMock.keyCoCreator.findFirst.mockResolvedValueOnce({
         role: 'CONTENT',
      });

      const middleware = validateCoCreatorPermission('CONTENT');
      const { req, res, next } = mockReqRes({ keyId: 'key-1' }, {}, { wallet: 'CONTENT_WALLET' });

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
   });

   it('blocks CONTENT role on non-announcement/REVENUE endpoint with 403', async () => {
      prismaMock.creatorProfile.findUnique.mockResolvedValueOnce({
         id: 'key-1',
         userId: 'PRIMARY_WALLET',
      });
      prismaMock.keyCoCreator.findFirst.mockResolvedValueOnce({
         role: 'CONTENT',
      });

      const middleware = validateCoCreatorPermission('REVENUE');
      const { req, res, next, statusMock, jsonMock } = mockReqRes(
         { keyId: 'key-1' },
         {},
         { wallet: 'CONTENT_WALLET' }
      );

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(403);
      expect(jsonMock).toHaveBeenCalledWith(
         expect.objectContaining({
            error: expect.objectContaining({
               role_required: 'REVENUE',
               current_role: 'CONTENT',
            }),
         })
      );
   });

   it('blocks REVENUE role on non-revenue/CONTENT endpoint with 403', async () => {
      prismaMock.creatorProfile.findUnique.mockResolvedValueOnce({
         id: 'key-1',
         userId: 'PRIMARY_WALLET',
      });
      prismaMock.keyCoCreator.findFirst.mockResolvedValueOnce({
         role: 'REVENUE',
      });

      const middleware = validateCoCreatorPermission('CONTENT');
      const { req, res, next, statusMock, jsonMock } = mockReqRes(
         { keyId: 'key-1' },
         {},
         { wallet: 'REVENUE_WALLET' }
      );

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(403);
      expect(jsonMock).toHaveBeenCalledWith(
         expect.objectContaining({
            error: expect.objectContaining({
               role_required: 'CONTENT',
               current_role: 'REVENUE',
            }),
         })
      );
   });

   it('blocks unauthenticated or non-co-creator with NONE role and 403', async () => {
      prismaMock.creatorProfile.findUnique.mockResolvedValueOnce({
         id: 'key-1',
         userId: 'PRIMARY_WALLET',
      });
      prismaMock.keyCoCreator.findFirst.mockResolvedValueOnce(null);

      const middleware = validateCoCreatorPermission('ADMIN');
      const { req, res, next, statusMock, jsonMock } = mockReqRes(
         { keyId: 'key-1' },
         {},
         { wallet: 'STRANGER_WALLET' }
      );

      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(403);
      expect(jsonMock).toHaveBeenCalledWith(
         expect.objectContaining({
            error: expect.objectContaining({
               role_required: 'ADMIN',
               current_role: 'NONE',
            }),
         })
      );
   });
});
