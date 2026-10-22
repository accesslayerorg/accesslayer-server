// Route tests: GET /keys/:keyId/export and GET /keys/exports/:jobId/download
// The export service is mocked; the real query schema and token error are kept
// so validation and error mapping are exercised.

jest.mock('./key-export.service', () => {
   const actual = jest.requireActual('./key-export.service');
   return {
      ...actual,
      createKeyExportJob: jest.fn(),
      resolveKeyExportDownload: jest.fn(),
   };
});

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import keysRouter from './keys.routes';
import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';
import {
   createKeyExportJob,
   resolveKeyExportDownload,
   ExportDownloadTokenError,
} from './key-export.service';

const mockCreate = createKeyExportJob as jest.Mock;
const mockResolve = resolveKeyExportDownload as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api/v1/keys', keysRouter);

const CREATOR_WALLET = 'GCREATORWALLETADDRESS';
const creatorToken = jwt.sign(
   { sub: 'user-1', wallet: CREATOR_WALLET },
   envConfig.JWT_SECRET,
   { issuer: envConfig.JWT_ISSUER }
);

const creatorFindFirst = prisma.creatorProfile.findFirst as jest.Mock;
const walletFindUnique = prisma.stellarWallet.findUnique as jest.Mock;

beforeEach(() => {
   jest.clearAllMocks();
   creatorFindFirst.mockResolvedValue({ userId: 'user-1' });
   walletFindUnique.mockResolvedValue({ userId: 'user-1' });
});

const ACCEPTED = {
   jobId: 'job-1',
   keyId: 'key-1',
   status: 'PENDING',
   format: 'csv' as const,
   from: null,
   to: null,
   expiresAt: '2026-10-16T13:00:00.000Z',
   downloadUrl:
      'http://localhost:3000/api/v1/keys/exports/job-1/download?token=abc',
};

describe('GET /api/v1/keys/:keyId/export', () => {
   it('returns a signed download URL for the key creator', async () => {
      mockCreate.mockResolvedValue(ACCEPTED);

      const res = await request(app)
         .get('/api/v1/keys/key-1/export')
         .query({ format: 'csv' })
         .set('Authorization', `Bearer ${creatorToken}`);

      expect(res.status).toBe(202);
      expect(res.body.data.downloadUrl).toBe(ACCEPTED.downloadUrl);
      expect(mockCreate).toHaveBeenCalledWith({
         keyId: 'key-1',
         requestedBy: CREATOR_WALLET,
         format: 'csv',
         from: undefined,
         to: undefined,
      });
   });

   it('returns the URL within the 5 second budget', async () => {
      mockCreate.mockResolvedValue(ACCEPTED);
      const start = Date.now();

      const res = await request(app)
         .get('/api/v1/keys/key-1/export?format=json')
         .set('Authorization', `Bearer ${creatorToken}`);

      expect(res.status).toBe(202);
      expect(Date.now() - start).toBeLessThan(5000);
   });

   it('passes parsed from/to datetimes to the service', async () => {
      mockCreate.mockResolvedValue(ACCEPTED);

      await request(app)
         .get('/api/v1/keys/key-1/export')
         .query({ format: 'json', from: '2026-09-01T00:00:00Z', to: '2026-09-30T00:00:00Z' })
         .set('Authorization', `Bearer ${creatorToken}`);

      expect(mockCreate).toHaveBeenCalledWith(
         expect.objectContaining({
            from: new Date('2026-09-01T00:00:00Z'),
            to: new Date('2026-09-30T00:00:00Z'),
         })
      );
   });

   it('requires authentication', async () => {
      const res = await request(app).get('/api/v1/keys/key-1/export');
      expect(res.status).toBe(401);
      expect(mockCreate).not.toHaveBeenCalled();
   });

   it('rejects a non-creator wallet with 403', async () => {
      creatorFindFirst.mockResolvedValue({ userId: 'owner' });
      walletFindUnique.mockResolvedValue({ userId: 'someone-else' });

      const res = await request(app)
         .get('/api/v1/keys/key-1/export')
         .set('Authorization', `Bearer ${creatorToken}`);

      expect(res.status).toBe(403);
      expect(mockCreate).not.toHaveBeenCalled();
   });

   it('returns 404 when the key does not exist', async () => {
      creatorFindFirst.mockResolvedValue(null);

      const res = await request(app)
         .get('/api/v1/keys/missing/export')
         .set('Authorization', `Bearer ${creatorToken}`);

      expect(res.status).toBe(404);
      expect(mockCreate).not.toHaveBeenCalled();
   });

   it('returns 400 for an invalid format', async () => {
      const res = await request(app)
         .get('/api/v1/keys/key-1/export')
         .query({ format: 'xml' })
         .set('Authorization', `Bearer ${creatorToken}`);

      expect(res.status).toBe(400);
      expect(mockCreate).not.toHaveBeenCalled();
   });

   it('returns 400 when from is after to', async () => {
      const res = await request(app)
         .get('/api/v1/keys/key-1/export')
         .query({ from: '2026-09-30T00:00:00Z', to: '2026-09-01T00:00:00Z' })
         .set('Authorization', `Bearer ${creatorToken}`);

      expect(res.status).toBe(400);
      expect(mockCreate).not.toHaveBeenCalled();
   });
});

describe('GET /api/v1/keys/exports/:jobId/download', () => {
   it('serves a ready export as an attachment', async () => {
      mockResolve.mockResolvedValue({
         kind: 'ready',
         fileName: 'key-export-key-1.csv',
         contentType: 'text/csv; charset=utf-8',
         content: 'record_type\nrevenue_breakdown',
      });

      const res = await request(app).get(
         '/api/v1/keys/exports/job-1/download?token=signed'
      );

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toContain(
         'attachment; filename="key-export-key-1.csv"'
      );
      expect(res.text).toContain('record_type');
      expect(mockResolve).toHaveBeenCalledWith('job-1', 'signed');
   });

   it('returns 202 while the export is still generating', async () => {
      mockResolve.mockResolvedValue({ kind: 'pending', status: 'PROCESSING' });

      const res = await request(app).get(
         '/api/v1/keys/exports/job-1/download?token=signed'
      );

      expect(res.status).toBe(202);
      expect(res.body.data).toEqual({ jobId: 'job-1', status: 'PROCESSING' });
   });

   it('returns 403 for an invalid token', async () => {
      mockResolve.mockRejectedValue(new ExportDownloadTokenError('bad token'));

      const res = await request(app).get(
         '/api/v1/keys/exports/job-1/download?token=forged'
      );

      expect(res.status).toBe(403);
   });

   it('returns 410 when the link has expired', async () => {
      mockResolve.mockResolvedValue({ kind: 'expired' });

      const res = await request(app).get(
         '/api/v1/keys/exports/job-1/download?token=signed'
      );

      expect(res.status).toBe(410);
   });

   it('returns 404 for an unknown job', async () => {
      mockResolve.mockResolvedValue({ kind: 'not_found' });

      const res = await request(app).get(
         '/api/v1/keys/exports/job-1/download?token=signed'
      );

      expect(res.status).toBe(404);
   });

   it('returns 500 when generation failed', async () => {
      mockResolve.mockResolvedValue({ kind: 'failed', error: 'boom' });

      const res = await request(app).get(
         '/api/v1/keys/exports/job-1/download?token=signed'
      );

      expect(res.status).toBe(500);
   });
});
