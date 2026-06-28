jest.mock('chalk', () => ({
   red: (text: string) => text,
   green: (text: string) => text,
   magenta: (text: string) => text,
   cyan: (text: string) => text,
}));

jest.mock('tspec', () => ({
   TspecDocsMiddleware: jest.fn().mockResolvedValue([]),
}));

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      creatorProfile: {
         findUnique: jest.fn(),
         update: jest.fn(),
      },
      stellarWallet: {
         findUnique: jest.fn(),
      },
   },
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: {
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
      isLevelEnabled: jest.fn().mockReturnValue(false),
   },
}));

jest.mock('../../config', () => ({
   envConfig: {
      MODE: 'test',
      PORT: 3000,
      ENABLE_REQUEST_LOGGING: false,
   },
   appConfig: { allowedOrigins: [] },
}));

jest.mock('../../utils/background-job-lock.utils', () => ({
   acquireJobLock: jest.fn(() => ({
      acquired: true,
      expiresAt: '2026-01-01T00:00:00.000Z',
   })),
}));

jest.mock('../../utils/audit.utils', () => ({
   emitAuditEvent: jest.fn(),
}));

import supertest from 'supertest';
import app from '../../app';
import { withProtectedRouteHeaders } from '../../utils/test/protected-route-request.utils';

describe('POST /api/v1/admin/indexer/replay â€” protected route headers', () => {
   it('accepts a request with the default protected headers', async () => {
      const res = await withProtectedRouteHeaders(
         supertest(app)
            .post('/api/v1/admin/indexer/replay')
            .send({ startLedger: 12, dryRun: true })
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual(
         expect.objectContaining({
            success: true,
            data: expect.objectContaining({
               type: 'INDEXER_REPLAY_INITIATED',
               startLedger: 12,
               dryRun: true,
               initiatedBy: 'admin-test-1',
            }),
         })
      );
   });

   it('returns 403 when the admin header is removed through an override', async () => {
      const res = await withProtectedRouteHeaders(
         supertest(app)
            .post('/api/v1/admin/indexer/replay')
            .send({ startLedger: 12, dryRun: true }),
         { 'x-admin-id': undefined }
      );

      expect(res.status).toBe(403);
      expect(res.body).toEqual(
         expect.objectContaining({
            type: 'FORBIDDEN',
            message: 'Admin authorization required.',
         })
      );
   });
});
