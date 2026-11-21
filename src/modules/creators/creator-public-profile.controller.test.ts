// src/modules/creators/creator-public-profile.controller.test.ts
// Unit tests for public creator profile controller (#1009).

import { Request, Response } from 'express';
import {
   httpGetCreatorPublicProfile,
   httpGetCreatorIssuedKeys,
} from './creator-public-profile.controller';
import * as service from './creator-public-profile.service';

jest.mock('./creator-public-profile.service');

describe('Creator Public Profile Controllers (#1009)', () => {
   const validWallet = 'G' + 'A'.repeat(55);
   const unregisteredWallet = 'G' + 'B'.repeat(55);

   let req: Partial<Request>;
   let res: Partial<Response>;
   let next: jest.Mock;

   beforeEach(() => {
      jest.clearAllMocks();
      req = {
         params: {},
         query: {},
      };
      res = {
         status: jest.fn().mockReturnThis(),
         json: jest.fn().mockReturnThis(),
         setHeader: jest.fn().mockReturnThis(),
         set: jest.fn().mockReturnThis(),
      };
      next = jest.fn();
   });

   describe('httpGetCreatorPublicProfile', () => {
      it('returns 400 validation error when wallet address is invalid format', async () => {
         req.params = { wallet: 'invalid-wallet-format' };

         await httpGetCreatorPublicProfile(req as Request, res as Response, next);

         expect(res.status).toHaveBeenCalledWith(400);
         expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
               success: false,
               error: expect.objectContaining({
                  code: 'VALIDATION_ERROR',
                  message: 'Invalid wallet address',
               }),
            })
         );
      });

      it('returns 404 when wallet is unregistered (not found in DB)', async () => {
         req.params = { wallet: unregisteredWallet };
         (service.getCreatorPublicProfile as jest.Mock).mockResolvedValue(null);

         await httpGetCreatorPublicProfile(req as Request, res as Response, next);

         expect(res.status).toHaveBeenCalledWith(404);
         expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
               success: false,
               error: expect.objectContaining({
                  code: 'NOT_FOUND',
               }),
            })
         );
      });

      it('returns 200 with profile data for registered wallet', async () => {
         req.params = { wallet: validWallet };
         const mockProfile = {
            wallet: validWallet,
            memberSince: '2026-01-01T00:00:00.000Z',
            totalKeys: 2,
            totalVolume: '5000',
            avgRating: 4.8,
            isVerified: true,
            handle: 'test_creator',
            displayName: 'Test Creator',
            bio: 'Bio',
            avatarUrl: null,
            stats: {
               totalHolders: 10,
               totalTradingVolume: '5000',
               followersCount: 20,
            },
         };
         (service.getCreatorPublicProfile as jest.Mock).mockResolvedValue(mockProfile);

         await httpGetCreatorPublicProfile(req as Request, res as Response, next);

         expect(res.status).toHaveBeenCalledWith(200);
         expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
               success: true,
               data: mockProfile,
            })
         );
         expect(res.set).toHaveBeenCalledWith('X-Response-Timestamp', expect.any(String));
      });
   });

   describe('httpGetCreatorIssuedKeys', () => {
      it('returns 400 when pagination query parameter types are invalid', async () => {
         req.params = { wallet: validWallet };
         req.query = { limit: ['10', '20'] as any };

         await httpGetCreatorIssuedKeys(req as Request, res as Response, next);

         expect(res.status).toHaveBeenCalledWith(400);
         expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
               success: false,
               error: expect.objectContaining({
                  code: 'VALIDATION_ERROR',
                  message: 'Invalid keys pagination parameters',
               }),
            })
         );
      });

      it('returns 404 when wallet is not found', async () => {
         req.params = { wallet: unregisteredWallet };
         (service.getCreatorDeployedKeys as jest.Mock).mockResolvedValue(null);

         await httpGetCreatorIssuedKeys(req as Request, res as Response, next);

         expect(res.status).toHaveBeenCalledWith(404);
      });

      it('returns 200 with paginated keys in deployment order', async () => {
         req.params = { wallet: validWallet };
         req.query = { limit: '20' };
         const mockPage = {
            items: [
               {
                  id: 'key-1',
                  handle: 'key1',
                  displayName: 'Key 1',
                  bio: null,
                  avatarUrl: null,
                  isVerified: true,
                  holderCount: 5,
                  totalTradingVolume: '1000',
                  status: 'ACTIVE',
                  price: '100',
                  createdAt: '2026-01-01T00:00:00.000Z',
               },
            ],
            nextCursor: null,
            hasMore: false,
            limit: 20,
            stats: {
               totalKeys: 1,
               totalHolders: 5,
               totalTradingVolume: '1000',
            },
         };
         (service.getCreatorDeployedKeys as jest.Mock).mockResolvedValue(mockPage);

         await httpGetCreatorIssuedKeys(req as Request, res as Response, next);

         expect(res.status).toHaveBeenCalledWith(200);
         expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
               success: true,
               data: mockPage,
            })
         );
      });
   });
});
