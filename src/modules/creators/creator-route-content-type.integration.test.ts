// Integration test: creator route Content-Type header validation
//
// Creator route responses should always include a Content-Type header with
// the correct media type. This test asserts the header is present and correct
// to prevent accidental regressions when middleware or serialization changes.

import { httpListCreators } from './creators.controllers';
import { getCreatorProfileHandler } from '../creator/creator-profile.handlers';
import * as creatorsUtils from './creators.utils';
import * as creatorProfileService from '../creator/creator-profile.service';
import type { CreatorProfile } from '../../types/profile.types';

// ── Lightweight request/response mocks ────────────────────────────────────────

function makeReq(
   query: Record<string, string> = {},
   params: Record<string, string> = {}
): any {
   return { query, params, requestId: 'test-request-id' };
}

function makeRes(): any {
   const headers: Record<string, string> = {};
   const res: any = {};
   res.status = jest.fn().mockReturnValue(res);
   res.json = jest.fn().mockReturnValue(res);
   res.setHeader = jest
      .fn()
      .mockImplementation((name: string, value: string) => {
         headers[name.toLowerCase()] = value;
         return res;
      });
   res.set = jest.fn().mockReturnValue(res);
   res._headers = headers;
   return res;
}

function makeNext(): jest.Mock {
   return jest.fn();
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FIXTURE_CREATOR: CreatorProfile = {
   id: 'creator-123',
   userId: 'user-123',
   handle: 'test_creator',
   displayName: 'Test Creator',
   isVerified: true,
   createdAt: new Date('2024-01-01T00:00:00.000Z'),
   updatedAt: new Date('2024-01-01T00:00:00.000Z'),
};

const FIXTURE_PROFILE = {
   creatorId: 'creator-123',
   displayName: 'Test Creator',
   bio: 'Test bio',
   avatarUrl: 'https://example.com/avatar.png',
   createdAt: '2024-01-01T00:00:00.000Z',
   updatedAt: '2024-01-02T00:00:00.000Z',
   perks: [],
   links: [],
   currentPrice: null,
   price24hAgo: null,
   priceChange24h: null,
   metadata: { source: 'database' as const, isProfileComplete: true },
};

describe('Creator routes — Content-Type header validation', () => {
   afterEach(() => {
      jest.restoreAllMocks();
   });

   describe('GET /api/v1/creators — list endpoint', () => {
      it('includes Content-Type header in response', async () => {
         jest
            .spyOn(creatorsUtils, 'fetchCreatorList')
            .mockResolvedValue([[FIXTURE_CREATOR], 1]);

         const req = makeReq({});
         const res = makeRes();
         await httpListCreators(req, res, makeNext());

         expect(res.status).toHaveBeenCalledWith(200);
         expect(res._headers['content-type']).toBeDefined();
      });

      it('Content-Type header is application/json', async () => {
         jest
            .spyOn(creatorsUtils, 'fetchCreatorList')
            .mockResolvedValue([[FIXTURE_CREATOR], 1]);

         const req = makeReq({});
         const res = makeRes();
         await httpListCreators(req, res, makeNext());

         expect(res._headers['content-type']).toMatch(/^application\/json/);
      });

      it('Content-Type header remains consistent across paginated requests', async () => {
         jest
            .spyOn(creatorsUtils, 'fetchCreatorList')
            .mockResolvedValue([[FIXTURE_CREATOR], 1]);

         // First page
         const req1 = makeReq({ offset: '0', limit: '10' });
         const res1 = makeRes();
         await httpListCreators(req1, res1, makeNext());

         const contentType1 = res1._headers['content-type'];

         // Second page
         const req2 = makeReq({ offset: '10', limit: '10' });
         const res2 = makeRes();
         await httpListCreators(req2, res2, makeNext());

         const contentType2 = res2._headers['content-type'];

         // Assert both pages have the same Content-Type
         expect(contentType1).toBeDefined();
         expect(contentType2).toBeDefined();
         expect(contentType1).toBe(contentType2);
      });

      it('Content-Type header is present even when result set is empty', async () => {
         jest
            .spyOn(creatorsUtils, 'fetchCreatorList')
            .mockResolvedValue([[], 0]);

         const req = makeReq({});
         const res = makeRes();
         await httpListCreators(req, res, makeNext());

         expect(res.status).toHaveBeenCalledWith(200);
         expect(res._headers['content-type']).toBeDefined();
         expect(res._headers['content-type']).toMatch(/^application\/json/);
      });
   });

   describe('GET /api/v1/creators/:creatorId/profile — detail endpoint', () => {
      it('includes Content-Type header in response', async () => {
         jest
            .spyOn(creatorProfileService, 'getCreatorProfile')
            .mockResolvedValue(FIXTURE_PROFILE);

         const req = makeReq({}, { creatorId: 'creator-123' });
         const res = makeRes();
         await getCreatorProfileHandler(req, res);

         expect(res.status).toHaveBeenCalledWith(200);
         expect(res._headers['content-type']).toBeDefined();
      });

      it('Content-Type header is application/json', async () => {
         jest
            .spyOn(creatorProfileService, 'getCreatorProfile')
            .mockResolvedValue(FIXTURE_PROFILE);

         const req = makeReq({}, { creatorId: 'creator-123' });
         const res = makeRes();
         await getCreatorProfileHandler(req, res);

         expect(res._headers['content-type']).toMatch(/^application\/json/);
      });

      it('Content-Type header remains consistent across multiple detail requests', async () => {
         jest
            .spyOn(creatorProfileService, 'getCreatorProfile')
            .mockResolvedValue(FIXTURE_PROFILE);

         // First request
         const req1 = makeReq({}, { creatorId: 'creator-123' });
         const res1 = makeRes();
         await getCreatorProfileHandler(req1, res1);

         const contentType1 = res1._headers['content-type'];

         // Second request
         const req2 = makeReq({}, { creatorId: 'creator-456' });
         const res2 = makeRes();
         await getCreatorProfileHandler(req2, res2);

         const contentType2 = res2._headers['content-type'];

         // Assert both requests have the same Content-Type
         expect(contentType1).toBeDefined();
         expect(contentType2).toBeDefined();
         expect(contentType1).toBe(contentType2);
      });
   });
});
