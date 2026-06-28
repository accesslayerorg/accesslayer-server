// Integration test: creator detail endpoint — maximum length bio preservation

import { Request, Response } from 'express';
import { prisma } from '../../utils/prisma.utils';
import { getCreatorProfileHandler } from './creator-profile.handlers';

const MAX_CREATOR_BIO_LENGTH = 1000;
const TEST_USER_ID = 'creator-long-bio-user';
const TEST_CREATOR_HANDLE = 'creator-long-bio';
const TEST_DISPLAY_NAME = 'Creator With Long Bio';
const MAX_LENGTH_BIO = 'A'.repeat(MAX_CREATOR_BIO_LENGTH);

function makeReq(params: Record<string, string> = {}) {
   return { params } as unknown as Request;
}

function makeRes() {
   const headers: Record<string, string> = {};
   const res: Partial<Response> = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn().mockImplementation((name: string, value: string) => {
         headers[name.toLowerCase()] = String(value);
         return res;
      }),
   };
   return { res: res as Response, headers };
}

describe('GET /api/v1/creators/:creatorId/profile — max-length bio', () => {
   let creatorId: string;

   beforeAll(async () => {
      await prisma.creatorProfile.deleteMany({
         where: { handle: TEST_CREATOR_HANDLE },
      });
      await prisma.user.deleteMany({ where: { id: TEST_USER_ID } });

      await prisma.user.create({
         data: {
            id: TEST_USER_ID,
            email: `${TEST_USER_ID}@example.com`,
            passwordHash: 'test-password-hash',
            firstName: 'Long',
            lastName: 'Bio',
         },
      });

      const creatorProfile = await prisma.creatorProfile.create({
         data: {
            userId: TEST_USER_ID,
            handle: TEST_CREATOR_HANDLE,
            displayName: TEST_DISPLAY_NAME,
            bio: MAX_LENGTH_BIO,
         },
      });

      creatorId = creatorProfile.id;
   });

   afterAll(async () => {
      await prisma.creatorProfile.deleteMany({
         where: { handle: TEST_CREATOR_HANDLE },
      });
      await prisma.user.deleteMany({ where: { id: TEST_USER_ID } });
      await prisma.$disconnect();
   });

   it('returns the full max-length bio without truncation or serialization error', async () => {
      const req = makeReq({ creatorId: TEST_CREATOR_HANDLE });
      const { res, headers } = makeRes();

      await getCreatorProfileHandler(req, res);

      const statusMock = (res.status as jest.Mock).mock;
      const jsonMock = res.json as jest.Mock;

      expect(statusMock.calls[0]?.[0]).toBe(200);
      expect(jsonMock).toHaveBeenCalledWith(
         expect.objectContaining({
            success: true,
            data: expect.objectContaining({
               creatorId,
               displayName: TEST_DISPLAY_NAME,
               bio: MAX_LENGTH_BIO,
               avatarUrl: null,
               createdAt: expect.any(String),
               updatedAt: expect.any(String),
               perks: [],
               links: [],
               metadata: {
                  source: 'database',
                  isProfileComplete: true,
               },
            }),
         })
      );

      const body = jsonMock.mock.calls[0][0];
      expect(body.data.bio).toHaveLength(MAX_CREATOR_BIO_LENGTH);
      expect(headers['content-type']).toBe('application/json');
   });
});
