// HTTP-level tests for key report endpoints (#1226).
//
// Exercises the real JWT auth, moderator guard and per-wallet rate limiter
// (backed by an in-memory sorted-set Redis fake); the service layer is mocked
// and covered separately in key-reports.service.test.ts.

type ZEntry = { score: number; member: string };
const mockZsets = new Map<string, ZEntry[]>();

function mockBuildInMemoryRedis() {
   return {
      pipeline() {
         const ops: Array<() => [null, unknown]> = [];
         const p = {
            zremrangebyscore(key: string, min: number, max: number) {
               ops.push(() => {
                  const set = mockZsets.get(key) ?? [];
                  const kept = set.filter(e => e.score < min || e.score > max);
                  mockZsets.set(key, kept);
                  return [null, set.length - kept.length];
               });
               return p;
            },
            zadd(key: string, score: number, member: string) {
               ops.push(() => {
                  const set = mockZsets.get(key) ?? [];
                  set.push({ score, member });
                  mockZsets.set(key, set);
                  return [null, 1];
               });
               return p;
            },
            zcard(key: string) {
               ops.push(() => [null, (mockZsets.get(key) ?? []).length]);
               return p;
            },
            pexpire() {
               ops.push(() => [null, 1]);
               return p;
            },
            async exec() {
               return ops.map(op => op());
            },
         };
         return p;
      },
   };
}

jest.mock('../../utils/redis.utils', () => ({
   ...jest.requireActual('../../utils/redis.utils'),
   getRedis: jest.fn(() => mockBuildInMemoryRedis()),
}));

jest.mock('./key-reports.service', () => {
   class KeyReportKeyNotFoundError extends Error {}
   class DuplicateOpenKeyReportError extends Error {
      constructor() {
         super('You already have an open report for this key');
      }
   }
   class KeyReportNotFoundError extends Error {}
   class InvalidKeyReportTransitionError extends Error {}
   class InvalidKeyReportCursorError extends Error {}
   return {
      KeyReportKeyNotFoundError,
      DuplicateOpenKeyReportError,
      KeyReportNotFoundError,
      InvalidKeyReportTransitionError,
      InvalidKeyReportCursorError,
      createKeyReport: jest.fn(),
      listKeyReports: jest.fn(),
      updateKeyReportStatus: jest.fn(),
   };
});

import express from 'express';
import request from 'supertest';
import { envConfig } from '../../config';
import { signWalletAccessToken } from '../../utils/jwt.utils';
import { adminReportsRouter, keyReportsRouter } from './key-reports.routes';
import {
   createKeyReport,
   DuplicateOpenKeyReportError,
   InvalidKeyReportCursorError,
   InvalidKeyReportTransitionError,
   KeyReportKeyNotFoundError,
   KeyReportNotFoundError,
   listKeyReports,
   updateKeyReportStatus,
} from './key-reports.service';

const mockCreate = createKeyReport as jest.Mock;
const mockList = listKeyReports as jest.Mock;
const mockUpdate = updateKeyReportStatus as jest.Mock;

const REPORTER = `G${'R'.repeat(55)}`;
const OTHER_REPORTER = `G${'S'.repeat(55)}`;
const MODERATOR = `G${'M'.repeat(55)}`;

const app = express();
app.use(express.json());
app.use('/api/v1/keys', keyReportsRouter);
app.use('/api/v1/admin/reports', adminReportsRouter);

const bearer = (wallet: string) => `Bearer ${signWalletAccessToken(wallet)}`;

function reportFixture(overrides: Record<string, unknown> = {}) {
   return {
      id: 'report-1',
      keyId: 'key-1',
      reporter: REPORTER,
      reason: 'scam',
      details: null,
      status: 'open',
      createdAt: '2026-11-20T10:00:00.000Z',
      updatedAt: '2026-11-20T10:00:00.000Z',
      ...overrides,
   };
}

const originalModerators = envConfig.MODERATOR_WALLETS;

beforeEach(() => {
   jest.clearAllMocks();
   mockZsets.clear();
   envConfig.MODERATOR_WALLETS = MODERATOR;
});

afterAll(() => {
   envConfig.MODERATOR_WALLETS = originalModerators;
});

describe('POST /keys/:keyId/reports', () => {
   it('stores a valid report with status open and returns 201', async () => {
      mockCreate.mockResolvedValue(reportFixture({ details: 'fake giveaway' }));

      const res = await request(app)
         .post('/api/v1/keys/key-1/reports')
         .set('Authorization', bearer(REPORTER))
         .send({ reason: 'scam', details: 'fake giveaway' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('open');
      expect(mockCreate).toHaveBeenCalledWith('key-1', REPORTER, {
         reason: 'scam',
         details: 'fake giveaway',
      });
   });

   it('accepts a report without details', async () => {
      mockCreate.mockResolvedValue(reportFixture());
      const res = await request(app)
         .post('/api/v1/keys/key-1/reports')
         .set('Authorization', bearer(REPORTER))
         .send({ reason: 'other' });

      expect(res.status).toBe(201);
      expect(mockCreate).toHaveBeenCalledWith('key-1', REPORTER, {
         reason: 'other',
      });
   });

   it('returns 401 for unauthenticated requests', async () => {
      const res = await request(app)
         .post('/api/v1/keys/key-1/reports')
         .send({ reason: 'scam' });

      expect(res.status).toBe(401);
      expect(mockCreate).not.toHaveBeenCalled();
   });

   it('returns 401 for an invalid token', async () => {
      const res = await request(app)
         .post('/api/v1/keys/key-1/reports')
         .set('Authorization', 'Bearer not-a-jwt')
         .send({ reason: 'scam' });

      expect(res.status).toBe(401);
      expect(mockCreate).not.toHaveBeenCalled();
   });

   it('returns 400 for an invalid reason', async () => {
      const res = await request(app)
         .post('/api/v1/keys/key-1/reports')
         .set('Authorization', bearer(REPORTER))
         .send({ reason: 'spam' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details[0].field).toBe('reason');
      expect(mockCreate).not.toHaveBeenCalled();
   });

   it('returns 400 when reason is missing', async () => {
      const res = await request(app)
         .post('/api/v1/keys/key-1/reports')
         .set('Authorization', bearer(REPORTER))
         .send({});

      expect(res.status).toBe(400);
   });

   it('returns 400 when details exceed 500 characters', async () => {
      const res = await request(app)
         .post('/api/v1/keys/key-1/reports')
         .set('Authorization', bearer(REPORTER))
         .send({ reason: 'harassment', details: 'x'.repeat(501) });

      expect(res.status).toBe(400);
      expect(res.body.error.details[0].field).toBe('details');
      expect(mockCreate).not.toHaveBeenCalled();
   });

   it('accepts details of exactly 500 characters', async () => {
      mockCreate.mockResolvedValue(reportFixture());
      const res = await request(app)
         .post('/api/v1/keys/key-1/reports')
         .set('Authorization', bearer(REPORTER))
         .send({ reason: 'harassment', details: 'x'.repeat(500) });

      expect(res.status).toBe(201);
   });

   it('returns 400 for non-string details and unknown fields', async () => {
      const nonString = await request(app)
         .post('/api/v1/keys/key-1/reports')
         .set('Authorization', bearer(REPORTER))
         .send({ reason: 'scam', details: 42 });
      expect(nonString.status).toBe(400);

      const unknownField = await request(app)
         .post('/api/v1/keys/key-1/reports')
         .set('Authorization', bearer(REPORTER))
         .send({ reason: 'scam', status: 'actioned' });
      expect(unknownField.status).toBe(400);
   });

   it('returns 404 when the key does not exist', async () => {
      mockCreate.mockRejectedValue(new KeyReportKeyNotFoundError('missing'));
      const res = await request(app)
         .post('/api/v1/keys/missing/reports')
         .set('Authorization', bearer(REPORTER))
         .send({ reason: 'scam' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
   });

   it('returns 409 for a duplicate open report from the same wallet', async () => {
      mockCreate.mockRejectedValue(new DuplicateOpenKeyReportError('report-1'));
      const res = await request(app)
         .post('/api/v1/keys/key-1/reports')
         .set('Authorization', bearer(REPORTER))
         .send({ reason: 'scam' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
   });

   it('returns 429 on the sixth report within an hour from the same wallet', async () => {
      mockCreate.mockResolvedValue(reportFixture());
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
         const res = await request(app)
            .post(`/api/v1/keys/key-${i}/reports`)
            .set('Authorization', bearer(REPORTER))
            .send({ reason: 'scam' });
         statuses.push(res.status);
      }

      expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
      expect(mockCreate).toHaveBeenCalledTimes(5);
   });

   it('rate limits per wallet, not globally', async () => {
      mockCreate.mockResolvedValue(reportFixture());
      for (let i = 0; i < 5; i++) {
         await request(app)
            .post(`/api/v1/keys/key-${i}/reports`)
            .set('Authorization', bearer(REPORTER))
            .send({ reason: 'scam' });
      }

      const other = await request(app)
         .post('/api/v1/keys/key-1/reports')
         .set('Authorization', bearer(OTHER_REPORTER))
         .send({ reason: 'scam' });
      expect(other.status).toBe(201);
   });

   it('resets the limit once the hour window has passed', async () => {
      mockCreate.mockResolvedValue(reportFixture());
      const realNow = Date.now;
      const start = realNow();
      try {
         Date.now = () => start;
         for (let i = 0; i < 6; i++) {
            await request(app)
               .post(`/api/v1/keys/key-${i}/reports`)
               .set('Authorization', bearer(REPORTER))
               .send({ reason: 'scam' });
         }
         Date.now = () => start + 60 * 60 * 1000 + 1;
         const res = await request(app)
            .post('/api/v1/keys/key-9/reports')
            .set('Authorization', bearer(REPORTER))
            .send({ reason: 'scam' });
         expect(res.status).toBe(201);
      } finally {
         Date.now = realNow;
      }
   });
});

describe('GET /admin/reports', () => {
   it('returns 401 for unauthenticated requests', async () => {
      const res = await request(app).get('/api/v1/admin/reports');
      expect(res.status).toBe(401);
   });

   it('returns 403 for non-moderator wallets', async () => {
      const res = await request(app)
         .get('/api/v1/admin/reports')
         .set('Authorization', bearer(REPORTER));

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      expect(mockList).not.toHaveBeenCalled();
   });

   it('returns 403 for everyone when no moderators are configured', async () => {
      envConfig.MODERATOR_WALLETS = undefined;
      const res = await request(app)
         .get('/api/v1/admin/reports')
         .set('Authorization', bearer(MODERATOR));
      expect(res.status).toBe(403);
   });

   it('returns the queue for moderators with default page size', async () => {
      mockList.mockResolvedValue({
         data: [reportFixture()],
         meta: { limit: 20, hasMore: false, nextCursor: null },
      });
      const res = await request(app)
         .get('/api/v1/admin/reports')
         .set('Authorization', bearer(MODERATOR));

      expect(res.status).toBe(200);
      expect(res.body.data.data).toHaveLength(1);
      expect(res.body.data.meta.nextCursor).toBeNull();
      expect(mockList).toHaveBeenCalledWith({ limit: 20 });
   });

   it('passes status, cursor and limit through to the service', async () => {
      mockList.mockResolvedValue({
         data: [],
         meta: { limit: 5, hasMore: false, nextCursor: null },
      });
      const res = await request(app)
         .get('/api/v1/admin/reports?status=reviewing&cursor=abc.def&limit=5')
         .set('Authorization', bearer(MODERATOR));

      expect(res.status).toBe(200);
      expect(mockList).toHaveBeenCalledWith({
         status: 'reviewing',
         cursor: 'abc.def',
         limit: 5,
      });
   });

   it('returns 400 for an invalid status filter', async () => {
      const res = await request(app)
         .get('/api/v1/admin/reports?status=closed')
         .set('Authorization', bearer(MODERATOR));

      expect(res.status).toBe(400);
      expect(res.body.error.details[0].field).toBe('status');
      expect(mockList).not.toHaveBeenCalled();
   });

   it('returns 400 for a limit above the maximum', async () => {
      const res = await request(app)
         .get('/api/v1/admin/reports?limit=101')
         .set('Authorization', bearer(MODERATOR));
      expect(res.status).toBe(400);
   });

   it('returns 400 for a malformed cursor', async () => {
      mockList.mockRejectedValue(
         new InvalidKeyReportCursorError('Invalid cursor')
      );
      const res = await request(app)
         .get('/api/v1/admin/reports?cursor=garbage')
         .set('Authorization', bearer(MODERATOR));

      expect(res.status).toBe(400);
      expect(res.body.error.details[0].field).toBe('cursor');
   });
});

describe('PATCH /admin/reports/:id', () => {
   it('returns 401 for unauthenticated requests', async () => {
      const res = await request(app)
         .patch('/api/v1/admin/reports/report-1')
         .send({ status: 'reviewing' });
      expect(res.status).toBe(401);
   });

   it('returns 403 for non-moderator wallets', async () => {
      const res = await request(app)
         .patch('/api/v1/admin/reports/report-1')
         .set('Authorization', bearer(REPORTER))
         .send({ status: 'reviewing' });

      expect(res.status).toBe(403);
      expect(mockUpdate).not.toHaveBeenCalled();
   });

   it('persists a valid transition and returns the updated report', async () => {
      mockUpdate.mockResolvedValue(reportFixture({ status: 'reviewing' }));
      const res = await request(app)
         .patch('/api/v1/admin/reports/report-1')
         .set('Authorization', bearer(MODERATOR))
         .send({ status: 'reviewing' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('reviewing');
      expect(mockUpdate).toHaveBeenCalledWith('report-1', 'reviewing');
   });

   it('returns 400 when trying to set status back to open', async () => {
      const res = await request(app)
         .patch('/api/v1/admin/reports/report-1')
         .set('Authorization', bearer(MODERATOR))
         .send({ status: 'open' });

      expect(res.status).toBe(400);
      expect(mockUpdate).not.toHaveBeenCalled();
   });

   it('returns 400 for an unknown status value or missing body', async () => {
      const unknown = await request(app)
         .patch('/api/v1/admin/reports/report-1')
         .set('Authorization', bearer(MODERATOR))
         .send({ status: 'closed' });
      expect(unknown.status).toBe(400);

      const missing = await request(app)
         .patch('/api/v1/admin/reports/report-1')
         .set('Authorization', bearer(MODERATOR))
         .send({});
      expect(missing.status).toBe(400);
   });

   it('returns 409 for an invalid transition', async () => {
      mockUpdate.mockRejectedValue(
         new InvalidKeyReportTransitionError('dismissed', 'actioned')
      );
      const res = await request(app)
         .patch('/api/v1/admin/reports/report-1')
         .set('Authorization', bearer(MODERATOR))
         .send({ status: 'actioned' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
   });

   it('returns 404 for an unknown report id', async () => {
      mockUpdate.mockRejectedValue(new KeyReportNotFoundError('missing'));
      const res = await request(app)
         .patch('/api/v1/admin/reports/missing')
         .set('Authorization', bearer(MODERATOR))
         .send({ status: 'dismissed' });

      expect(res.status).toBe(404);
   });
});
