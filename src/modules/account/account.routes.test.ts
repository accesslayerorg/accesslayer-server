import express from 'express';
import request from 'supertest';
import { signWalletAccessToken } from '../../utils/jwt.utils';
import { prisma } from '../../utils/prisma.utils';
import { accountRouter } from './account.routes';
import {
   requestAccountDeletion,
   DeletionBlockedError,
} from './account-deletion.service';
import {
   DataExportInProgressError,
   InvalidDownloadLinkError,
   readDataExportDownload,
   requestDataExport,
} from './data-export.service';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: { stellarWallet: { findUnique: jest.fn() } },
}));

jest.mock('./data-export.service', () => {
   class DataExportInProgressError extends Error {}
   class DataExportNotFoundError extends Error {}
   class InvalidDownloadLinkError extends Error {
      constructor() {
         super('Download link is invalid or has expired');
      }
   }
   return {
      DataExportInProgressError,
      DataExportNotFoundError,
      InvalidDownloadLinkError,
      requestDataExport: jest.fn(),
      getDataExportJob: jest.fn(),
      readDataExportDownload: jest.fn(),
   };
});

jest.mock('./account-deletion.service', () => {
   class DeletionBlockedError extends Error {
      constructor(public readonly blockers: Array<{ code: string; count: number; message: string }>) {
         super('Account deletion is blocked by outstanding obligations');
      }
   }
   class DeletionAlreadyRequestedError extends Error {}
   class AccountNotFoundError extends Error {}
   class NoPendingDeletionError extends Error {}
   class DeletionGracePeriodEndedError extends Error {}
   return {
      DeletionBlockedError,
      DeletionAlreadyRequestedError,
      AccountNotFoundError,
      NoPendingDeletionError,
      DeletionGracePeriodEndedError,
      requestAccountDeletion: jest.fn(),
      getAccountDeletion: jest.fn(),
      cancelAccountDeletion: jest.fn(),
   };
});

const WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const app = express();
app.use(express.json());
app.use('/api/v1/me', accountRouter);
app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
   res.status(500).json({ success: false });
});

const findWallet = prisma.stellarWallet.findUnique as unknown as jest.Mock;
const mockedRequestExport = requestDataExport as unknown as jest.Mock;
const mockedRequestDeletion = requestAccountDeletion as unknown as jest.Mock;
const mockedDownload = readDataExportDownload as unknown as jest.Mock;

beforeEach(() => {
   jest.clearAllMocks();
   findWallet.mockResolvedValue({ userId: 'user-1' });
});

const auth = () => ({ Authorization: `Bearer ${signWalletAccessToken(WALLET)}` });

describe('account routes', () => {
   it('requires a wallet token', async () => {
      const res = await request(app).post('/api/v1/me/data-export');
      expect(res.status).toBe(401);
      expect(mockedRequestExport).not.toHaveBeenCalled();
   });

   it('refuses a wallet that is not linked to a user', async () => {
      findWallet.mockResolvedValue(null);
      const res = await request(app).post('/api/v1/me/data-export').set(auth());
      expect(res.status).toBe(401);
      expect(res.body.error.message).toMatch(/not linked/);
      expect(mockedRequestExport).not.toHaveBeenCalled();
   });

   it('queues an export for the linked user and returns 202', async () => {
      mockedRequestExport.mockResolvedValue({ id: 'job-1', status: 'queued', downloadUrl: null });
      const res = await request(app).post('/api/v1/me/data-export').set(auth());
      expect(res.status).toBe(202);
      expect(res.body.data.id).toBe('job-1');
      expect(mockedRequestExport).toHaveBeenCalledWith('user-1');
   });

   it('returns 409 when an export is already running', async () => {
      mockedRequestExport.mockRejectedValue(new DataExportInProgressError('job-0'));
      const res = await request(app).post('/api/v1/me/data-export').set(auth());
      expect(res.status).toBe(409);
   });

   it('lists each obligation blocking deletion in the 409 details', async () => {
      mockedRequestDeletion.mockRejectedValue(
         new DeletionBlockedError([{ code: 'open_orders', count: 2, message: '2 open limit order(s)' }])
      );
      const res = await request(app).post('/api/v1/me/deletion').set(auth());
      expect(res.status).toBe(409);
      expect(res.body.error.details).toEqual([
         { field: 'open_orders', message: '2 open limit order(s)' },
      ]);
   });

   it('rejects a download with an invalid signature', async () => {
      mockedDownload.mockRejectedValue(new InvalidDownloadLinkError());
      const res = await request(app).get('/api/v1/me/data-export/job-1/download').query({
         expires: 1_800_000_000_000,
         sig: 'forged',
      });
      expect(res.status).toBe(403);
   });

   it('returns the archive as an attachment for a valid link', async () => {
      mockedDownload.mockResolvedValue({ schemaVersion: 1 });
      const res = await request(app).get('/api/v1/me/data-export/job-1/download').query({
         expires: 1_800_000_000_000,
         sig: 'valid',
      });
      expect(res.status).toBe(200);
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.body).toEqual({ schemaVersion: 1 });
   });
});
