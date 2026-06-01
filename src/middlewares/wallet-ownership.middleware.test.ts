import { Request, Response, NextFunction } from 'express';
import { requireCreatorProfileOwnership } from './wallet-ownership.middleware';
import * as walletOwnership from '../utils/wallet-ownership.utils';

jest.mock('../utils/wallet-ownership.utils', () => ({
   checkCreatorProfileOwnership: jest.fn(),
}));

const mockedCheck =
   walletOwnership.checkCreatorProfileOwnership as jest.MockedFunction<
      typeof walletOwnership.checkCreatorProfileOwnership
   >;

function buildRes() {
   const json = jest.fn();
   const status = jest.fn().mockImplementation(() => ({ json }));
   const setHeader = jest.fn();
   return { json, status, setHeader } as unknown as Response & {
      status: jest.Mock;
      json: jest.Mock;
   };
}

function buildReq(opts: {
   address?: string | string[];
   creatorId?: string;
}): Request {
   return {
      headers:
         opts.address !== undefined ? { 'x-wallet-address': opts.address } : {},
      params: opts.creatorId !== undefined ? { creatorId: opts.creatorId } : {},
   } as unknown as Request;
}

describe('requireCreatorProfileOwnership', () => {
   beforeEach(() => {
      mockedCheck.mockReset();
   });

   it('returns 401 when the wallet header is missing', async () => {
      const req = buildReq({ creatorId: 'alice' });
      const res = buildRes();
      const next = jest.fn();

      await requireCreatorProfileOwnership()(req, res, next as NextFunction);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
      expect(mockedCheck).not.toHaveBeenCalled();
   });

   it('returns 400 when the path parameter is missing', async () => {
      const req = buildReq({ address: 'GABC' });
      const res = buildRes();
      const next = jest.fn();

      await requireCreatorProfileOwnership()(req, res, next as NextFunction);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
   });

   it('returns 401 when the helper reports an unknown wallet', async () => {
      mockedCheck.mockResolvedValue({
         status: 'wallet_not_found',
         address: 'GABC',
      });
      const req = buildReq({ address: 'GABC', creatorId: 'alice' });
      const res = buildRes();
      const next = jest.fn();

      await requireCreatorProfileOwnership()(req, res, next as NextFunction);

      expect(mockedCheck).toHaveBeenCalledWith('GABC', 'alice');
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
   });

   it('returns 403 when the helper reports forbidden ownership', async () => {
      mockedCheck.mockResolvedValue({
         status: 'forbidden',
         address: 'GABC',
         ownerUserId: 'someone-else',
      });
      const req = buildReq({ address: 'GABC', creatorId: 'alice' });
      const res = buildRes();
      const next = jest.fn();

      await requireCreatorProfileOwnership()(req, res, next as NextFunction);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
   });

   it('calls next and attaches owner metadata when access is granted', async () => {
      mockedCheck.mockResolvedValue({
         status: 'granted',
         ownerUserId: 'user-1',
      });
      const req = buildReq({ address: 'GABC', creatorId: 'alice' });
      const res = buildRes();
      const next = jest.fn();

      await requireCreatorProfileOwnership()(req, res, next as NextFunction);

      expect(next).toHaveBeenCalledWith();
      expect((req as Request & { walletAddress?: string }).walletAddress).toBe(
         'GABC'
      );
      expect((req as Request & { ownerUserId?: string }).ownerUserId).toBe(
         'user-1'
      );
      expect(res.status).not.toHaveBeenCalled();
   });

   it('uses the first value of an array-form wallet header', async () => {
      mockedCheck.mockResolvedValue({
         status: 'granted',
         ownerUserId: 'user-1',
      });
      const req = buildReq({
         address: ['GFIRST', 'GSECOND'],
         creatorId: 'alice',
      });
      const res = buildRes();
      const next = jest.fn();

      await requireCreatorProfileOwnership()(req, res, next as NextFunction);

      expect(mockedCheck).toHaveBeenCalledWith('GFIRST', 'alice');
      expect(next).toHaveBeenCalledWith();
   });

   it('returns 500 when the helper throws', async () => {
      mockedCheck.mockRejectedValue(new Error('db down'));
      const req = buildReq({ address: 'GABC', creatorId: 'alice' });
      const res = buildRes();
      const next = jest.fn();
      const errorSpy = jest
         .spyOn(console, 'error')
         .mockImplementation(() => {});

      await requireCreatorProfileOwnership()(req, res, next as NextFunction);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(next).not.toHaveBeenCalled();
      errorSpy.mockRestore();
   });
});
