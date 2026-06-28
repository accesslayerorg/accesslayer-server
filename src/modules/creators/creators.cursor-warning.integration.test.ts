import { httpListCreators } from './creators.controllers';
import * as creatorsUtils from './creators.utils';
import { logger } from '../../utils/logger.utils';
import { prisma } from '../../utils/prisma.utils';
import { encodeCursor } from '../../utils/cursor.utils';
import { CreatorProfile } from '../../types/profile.types';

function makeReq(query: Record<string, any> = {}, path = '/api/v1/creators'): any {
   return {
      query,
      path,
      requestId: 'test-request-id',
   };
}

function makeRes(): any {
   const res: any = {};
   res.status = jest.fn().mockReturnValue(res);
   res.json = jest.fn().mockReturnValue(res);
   res.setHeader = jest.fn().mockReturnValue(res);
   res.set = jest.fn().mockReturnValue(res);
   return res;
}

function makeNext(): jest.Mock {
   return jest.fn();
}

describe('Pagination Boundary Warnings - Out-of-range cursors', () => {
   const sampleProfile: CreatorProfile = {
      id: 'creator-1',
      userId: 'user-1',
      handle: 'creator_1',
      displayName: 'Creator One',
      isVerified: true,
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
   };

   let warnSpy: jest.SpyInstance;

   beforeEach(() => {
      jest.restoreAllMocks();
      warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

      // Mock fetchCreatorList to return a default mock result
      jest.spyOn(creatorsUtils, 'fetchCreatorList').mockResolvedValue([[sampleProfile], 1]);
   });

   it('does not log a warning when no cursor is provided', async () => {
      const req = makeReq({ limit: '10' });
      const res = makeRes();
      const next = makeNext();
      await httpListCreators(req, res, next);

      if (next.mock.calls.length > 0) {
         throw next.mock.calls[0][0];
      }

      expect(warnSpy).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
   });

   it('does not log a warning for a valid cursor pointing to an existing creator matching query filters', async () => {
      const validCursor = encodeCursor({
         id: sampleProfile.id,
         createdAt: sampleProfile.createdAt.toISOString(),
      });

      // Mock prisma.creatorProfile.findFirst to return the profile (exists)
      jest.spyOn(prisma.creatorProfile, 'findFirst').mockResolvedValue(sampleProfile as any);

      const req = makeReq({ cursor: validCursor });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(warnSpy).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(200);
   });

   it('logs a warning for an invalid or malformed cursor string, keeping response unchanged', async () => {
      const req = makeReq({ cursor: 'invalid-base64-string' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(warnSpy).toHaveBeenCalledWith(
         expect.objectContaining({
            msg: 'Out-of-range pagination cursor',
            route: '/api/v1/creators',
            cursor: 'invalid-base64-string',
            requestId: 'test-request-id',
         })
      );
      // Response must remain unchanged
      expect(res.status).toHaveBeenCalledWith(200);
   });

   it('logs a warning when a valid cursor references a non-existent creator profile', async () => {
      const validCursor = encodeCursor({
         id: 'non-existent-id',
         createdAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
      });

      // Mock prisma.creatorProfile.findFirst to return null (does not exist)
      jest.spyOn(prisma.creatorProfile, 'findFirst').mockResolvedValue(null);

      const req = makeReq({ cursor: validCursor });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(warnSpy).toHaveBeenCalledWith(
         expect.objectContaining({
            msg: 'Out-of-range pagination cursor',
            route: '/api/v1/creators',
            cursor: validCursor,
            cursorId: 'non-existent-id',
            cursorCreatedAt: '2024-01-01T00:00:00.000Z',
            requestId: 'test-request-id',
         })
      );
      // Response must remain unchanged
      expect(res.status).toHaveBeenCalledWith(200);
   });

   it('logs a warning when a valid cursor references a profile that exists but does not match query filters', async () => {
      const validCursor = encodeCursor({
         id: sampleProfile.id,
         createdAt: sampleProfile.createdAt.toISOString(),
      });

      // Mock prisma.creatorProfile.findFirst to return null because filters do not match
      jest.spyOn(prisma.creatorProfile, 'findFirst').mockResolvedValue(null);

      // Request verified=true, but mock findFirst returns null (meaning it does not match)
      const req = makeReq({ cursor: validCursor, verified: 'true' });
      const res = makeRes();
      await httpListCreators(req, res, makeNext());

      expect(warnSpy).toHaveBeenCalledWith(
         expect.objectContaining({
            msg: 'Out-of-range pagination cursor',
            route: '/api/v1/creators',
            cursor: validCursor,
            cursorId: sampleProfile.id,
            cursorCreatedAt: sampleProfile.createdAt.toISOString(),
            requestId: 'test-request-id',
         })
      );
      // Response must remain unchanged
      expect(res.status).toHaveBeenCalledWith(200);
   });
});
