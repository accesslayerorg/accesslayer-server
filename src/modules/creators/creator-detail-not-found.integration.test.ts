import supertest from 'supertest';
import { ErrorCode } from '../../constants/error.constants';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      $disconnect: jest.fn(),
   },
}));

jest.mock('../creator/creator-profile.service', () => ({
   creatorProfileExists: jest.fn().mockResolvedValue(false),
   getCreatorProfile: jest.fn(),
}));

describe('GET /api/v1/creators/:id — not found', () => {
   it('returns 404 with the standard error shape for a non-existent creator', async () => {
      const { default: app } = await import('../../app');

      const res = await supertest(app).get(
         '/api/v1/creators/non-existent-creator-for-404-test'
      );

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
         success: false,
         error: {
            code: ErrorCode.NOT_FOUND,
            message: expect.any(String),
         },
      });
      expect(res.body.error.code).toBe('NOT_FOUND');
      expect(res.body.error.message).toMatch(/creator.*not found/i);
   });
});
