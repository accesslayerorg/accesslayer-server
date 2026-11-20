// src/middlewares/co-creator-permission.middleware.test.ts

import { requireCoCreatorPermission } from './co-creator-permission.middleware';
import * as coCreatorService from '../modules/co-creators/co-creators.service';
import * as walletOwnershipUtils from '../utils/wallet-ownership.utils';

jest.mock('../modules/co-creators/co-creators.service', () => ({
   getCoCreatorDetail: jest.fn(),
}));

jest.mock('../utils/wallet-ownership.utils', () => ({
   checkCreatorProfileOwnership: jest.fn(),
}));

describe('requireCoCreatorPermission Middleware (#1156)', () => {
   let req: any;
   let res: any;
   let next: jest.Mock;

   beforeEach(() => {
      jest.clearAllMocks();
      req = {
         params: { keyId: 'key-1' },
         headers: { 'x-wallet-address': 'GCOCREATORWALLET11111111111111111111111111111111' },
         path: '/api/v1/keys/key-1/settings',
      };
      res = {
         status: jest.fn().mockReturnThis(),
         json: jest.fn().mockReturnThis(),
         setHeader: jest.fn().mockReturnThis(),
      };
      next = jest.fn();
   });

   it('returns 401 when wallet address is missing', async () => {
      req.headers = {};
      const middleware = requireCoCreatorPermission();
      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
   });

   it('returns 400 when keyId parameter is missing', async () => {
      req.params = {};
      const middleware = requireCoCreatorPermission();
      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(next).not.toHaveBeenCalled();
   });

   it('bypasses co-creator check when wallet is the primary creator', async () => {
      jest
        .spyOn(walletOwnershipUtils, 'checkCreatorProfileOwnership')
        .mockResolvedValueOnce({ status: 'granted', ownerUserId: 'user-1' });

      const middleware = requireCoCreatorPermission();
      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
   });

   it('ADMIN role passes all creator-action endpoints correctly', async () => {
      jest
        .spyOn(walletOwnershipUtils, 'checkCreatorProfileOwnership')
        .mockResolvedValueOnce({ status: 'forbidden', address: 'a', ownerUserId: 'user-2' });
      jest
        .spyOn(coCreatorService, 'getCoCreatorDetail')
        .mockResolvedValueOnce({
           key_id: 'key-1',
           wallet: 'GCOCREATORWALLET11111111111111111111111111111111',
           role: 'ADMIN',
           active: true,
           added_at: new Date().toISOString(),
           removed_at: null,
           share_bps: null,
        });

      req.path = '/api/v1/keys/key-1/revenue';
      const middleware = requireCoCreatorPermission();
      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
   });

   it('CONTENT role passes announcement endpoints correctly', async () => {
      jest
        .spyOn(walletOwnershipUtils, 'checkCreatorProfileOwnership')
        .mockResolvedValueOnce({ status: 'forbidden', address: 'a', ownerUserId: 'user-2' });
      jest
        .spyOn(coCreatorService, 'getCoCreatorDetail')
        .mockResolvedValueOnce({
           key_id: 'key-1',
           wallet: 'GCOCREATORWALLET11111111111111111111111111111111',
           role: 'CONTENT',
           active: true,
           added_at: new Date().toISOString(),
           removed_at: null,
           share_bps: null,
        });

      req.path = '/api/v1/keys/key-1/announcements';
      const middleware = requireCoCreatorPermission();
      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
   });

   it('CONTENT role is blocked correctly on non-announcement endpoints with 403, role_required, and current_role', async () => {
      jest
        .spyOn(walletOwnershipUtils, 'checkCreatorProfileOwnership')
        .mockResolvedValueOnce({ status: 'forbidden', address: 'a', ownerUserId: 'user-2' });
      jest
        .spyOn(coCreatorService, 'getCoCreatorDetail')
        .mockResolvedValueOnce({
           key_id: 'key-1',
           wallet: 'GCOCREATORWALLET11111111111111111111111111111111',
           role: 'CONTENT',
           active: true,
           added_at: new Date().toISOString(),
           removed_at: null,
           share_bps: null,
        });

      req.path = '/api/v1/keys/key-1/revenue';
      const middleware = requireCoCreatorPermission();
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
         expect.objectContaining({
            success: false,
            error: expect.objectContaining({
               code: 'FORBIDDEN',
               role_required: 'REVENUE',
               current_role: 'CONTENT',
            }),
         })
      );
   });

   it('REVENUE role passes revenue endpoints correctly', async () => {
      jest
        .spyOn(walletOwnershipUtils, 'checkCreatorProfileOwnership')
        .mockResolvedValueOnce({ status: 'forbidden', address: 'a', ownerUserId: 'user-2' });
      jest
        .spyOn(coCreatorService, 'getCoCreatorDetail')
        .mockResolvedValueOnce({
           key_id: 'key-1',
           wallet: 'GCOCREATORWALLET11111111111111111111111111111111',
           role: 'REVENUE',
           active: true,
           added_at: new Date().toISOString(),
           removed_at: null,
           share_bps: 500,
        });

      req.path = '/api/v1/keys/key-1/revenue';
      const middleware = requireCoCreatorPermission();
      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
   });

   it('REVENUE role is blocked correctly on non-revenue endpoints with 403, role_required, and current_role', async () => {
      jest
        .spyOn(walletOwnershipUtils, 'checkCreatorProfileOwnership')
        .mockResolvedValueOnce({ status: 'forbidden', address: 'a', ownerUserId: 'user-2' });
      jest
        .spyOn(coCreatorService, 'getCoCreatorDetail')
        .mockResolvedValueOnce({
           key_id: 'key-1',
           wallet: 'GCOCREATORWALLET11111111111111111111111111111111',
           role: 'REVENUE',
           active: true,
           added_at: new Date().toISOString(),
           removed_at: null,
           share_bps: 500,
        });

      req.path = '/api/v1/keys/key-1/announcements';
      const middleware = requireCoCreatorPermission();
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
         expect.objectContaining({
            success: false,
            error: expect.objectContaining({
               code: 'FORBIDDEN',
               role_required: 'CONTENT',
               current_role: 'REVENUE',
            }),
         })
      );
   });
});
