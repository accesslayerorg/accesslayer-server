jest.mock('../../config', () => ({
   envConfig: { JWT_SECRET: 'x'.repeat(48), BACKEND_URL: 'https://api.example.test/' },
}));
jest.mock('../../utils/logger.utils', () => ({
   logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      user: { findUnique: jest.fn() },
      creatorPost: { findMany: jest.fn() },
      comment: { findMany: jest.fn() },
      limitOrder: { findMany: jest.fn() },
      priceAlert: { findMany: jest.fn() },
      autoInvestRule: { findMany: jest.fn() },
      investorWatchlist: { findMany: jest.fn() },
      dataExportJob: {
         findFirst: jest.fn(),
         findUnique: jest.fn(),
         findMany: jest.fn(),
         create: jest.fn(),
         update: jest.fn(),
         updateMany: jest.fn(),
      },
   },
}));

import { prisma } from '../../utils/prisma.utils';
import { signLink } from '../../utils/signed-url.utils';
import {
   buildDataExportArchive,
   DataExportInProgressError,
   DataExportNotFoundError,
   getDataExportJob,
   InvalidDownloadLinkError,
   processDataExportJobs,
   readDataExportDownload,
   requestDataExport,
   toDataExportJobView,
} from './data-export.service';
import { DATA_EXPORT_LINK_TTL_MS, DATA_EXPORT_PURPOSE } from './account.constants';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const NOW = new Date('2026-11-24T12:00:00Z');
const decimal = (value: string) => ({ toString: () => value });

function accountRow(overrides: Record<string, unknown> = {}) {
   return {
      id: 'user-1',
      email: 'ada@example.test',
      firstName: 'Ada',
      lastName: 'Lovelace',
      phoneNumber: null,
      emailVerified: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      passwordHash: 'super-secret-hash',
      stellarWallet: { address: WALLET, createdAt: new Date('2026-01-02T00:00:00Z') },
      creatorProfiles: [
         {
            id: 'creator-1',
            handle: 'ada',
            displayName: 'Ada',
            bio: null,
            avatarUrl: null,
            twitter: null,
            website: null,
            discord: null,
            perkSummary: null,
            createdAt: new Date('2026-01-03T00:00:00Z'),
         },
      ],
      ...overrides,
   };
}

beforeEach(() => {
   jest.clearAllMocks();
   for (const delegate of [
      db.creatorPost,
      db.comment,
      db.limitOrder,
      db.priceAlert,
      db.autoInvestRule,
      db.investorWatchlist,
   ]) {
      delegate.findMany.mockResolvedValue([]);
   }
});

describe('buildDataExportArchive', () => {
   it('scopes every query to the requesting user and never includes the password hash', async () => {
      db.user.findUnique.mockResolvedValue(accountRow());
      db.creatorPost.findMany.mockResolvedValue([
         { id: 'post-1', creatorId: 'creator-1', content: 'hello', createdAt: NOW },
      ]);
      db.limitOrder.findMany.mockResolvedValue([
         {
            id: 'order-1',
            keyId: 'key-1',
            side: 'BUY',
            targetPrice: decimal('1.5'),
            quantity: decimal('2'),
            status: 'OPEN',
            expiresAt: null,
            createdAt: NOW,
         },
      ]);

      const archive = await buildDataExportArchive('user-1', NOW);

      expect(db.creatorPost.findMany).toHaveBeenCalledWith(
         expect.objectContaining({ where: { creatorId: { in: ['creator-1'] } } })
      );
      expect(db.comment.findMany).toHaveBeenCalledWith(
         expect.objectContaining({ where: { author: WALLET } })
      );
      expect(db.limitOrder.findMany).toHaveBeenCalledWith(
         expect.objectContaining({ where: { wallet: WALLET } })
      );
      expect(archive.orders[0].targetPrice).toBe('1.5');
      expect(archive.creatorPosts).toHaveLength(1);
      expect(JSON.stringify(archive)).not.toContain('super-secret-hash');
      expect(archive.generatedAt).toBe(NOW.toISOString());
   });

   it('skips wallet-scoped queries when the account has no linked wallet', async () => {
      db.user.findUnique.mockResolvedValue(accountRow({ stellarWallet: null, creatorProfiles: [] }));

      const archive = await buildDataExportArchive('user-1', NOW);

      expect(archive.wallet).toBeNull();
      expect(db.comment.findMany).not.toHaveBeenCalled();
      expect(db.limitOrder.findMany).not.toHaveBeenCalled();
      expect(db.creatorPost.findMany).not.toHaveBeenCalled();
   });

   it('throws when the user does not exist', async () => {
      db.user.findUnique.mockResolvedValue(null);
      await expect(buildDataExportArchive('missing')).rejects.toBeInstanceOf(DataExportNotFoundError);
   });
});

describe('requestDataExport', () => {
   it('refuses a second export while one is queued or processing', async () => {
      db.dataExportJob.findFirst.mockResolvedValue({ id: 'job-1' });
      await expect(requestDataExport('user-1')).rejects.toBeInstanceOf(DataExportInProgressError);
      expect(db.dataExportJob.create).not.toHaveBeenCalled();
   });

   it('queues a new job for the user', async () => {
      db.dataExportJob.findFirst.mockResolvedValue(null);
      db.dataExportJob.create.mockResolvedValue({
         id: 'job-2',
         status: 'queued',
         requestedAt: NOW,
         completedAt: null,
         expiresAt: null,
      });

      const view = await requestDataExport('user-1', NOW);

      expect(db.dataExportJob.create).toHaveBeenCalledWith({ data: { userId: 'user-1' } });
      expect(view).toMatchObject({ id: 'job-2', status: 'queued', downloadUrl: null });
   });
});

describe('getDataExportJob', () => {
   it('treats another user\'s job as not found', async () => {
      db.dataExportJob.findUnique.mockResolvedValue({
         id: 'job-3',
         userId: 'someone-else',
         status: 'completed',
         requestedAt: NOW,
         completedAt: NOW,
         expiresAt: new Date(NOW.getTime() + 1000),
      });
      await expect(getDataExportJob('user-1', 'job-3', NOW)).rejects.toBeInstanceOf(DataExportNotFoundError);
   });
});

describe('toDataExportJobView', () => {
   const base = { id: 'job-4', requestedAt: NOW, completedAt: NOW };

   it('issues a signed download link while the export is available', () => {
      const expiresAt = new Date(NOW.getTime() + DATA_EXPORT_LINK_TTL_MS);
      const view = toDataExportJobView({ ...base, status: 'completed', expiresAt }, NOW);
      const sig = signLink(DATA_EXPORT_PURPOSE, 'job-4', expiresAt.getTime());
      expect(view.status).toBe('completed');
      expect(view.downloadUrl).toBe(
         `https://api.example.test/v1/me/data-export/job-4/download?expires=${expiresAt.getTime()}&sig=${sig}`
      );
   });

   it('reports an elapsed download window as expired with no link', () => {
      const expiresAt = new Date(NOW.getTime() - 1);
      const view = toDataExportJobView({ ...base, status: 'completed', expiresAt }, NOW);
      expect(view.status).toBe('expired');
      expect(view.downloadUrl).toBeNull();
   });
});

describe('readDataExportDownload', () => {
   const archive = { schemaVersion: 1, account: { userId: 'user-1' } };
   const expiresAt = new Date(NOW.getTime() + DATA_EXPORT_LINK_TTL_MS);

   it('returns the archive for a valid, unexpired link', async () => {
      db.dataExportJob.findUnique.mockResolvedValue({
         id: 'job-5',
         status: 'completed',
         archive,
         expiresAt,
      });
      const sig = signLink(DATA_EXPORT_PURPOSE, 'job-5', expiresAt.getTime());

      await expect(
         readDataExportDownload('job-5', expiresAt.getTime(), sig, NOW)
      ).resolves.toEqual(archive);
   });

   it('rejects a tampered signature without touching the database', async () => {
      await expect(
         readDataExportDownload('job-5', expiresAt.getTime(), 'bogus', NOW)
      ).rejects.toBeInstanceOf(InvalidDownloadLinkError);
      expect(db.dataExportJob.findUnique).not.toHaveBeenCalled();
   });

   it('rejects an expired link', async () => {
      const sig = signLink(DATA_EXPORT_PURPOSE, 'job-5', expiresAt.getTime());
      await expect(
         readDataExportDownload('job-5', expiresAt.getTime(), sig, expiresAt)
      ).rejects.toBeInstanceOf(InvalidDownloadLinkError);
   });
});

describe('processDataExportJobs', () => {
   it('builds the archive for a queued job and sets the 24-hour download window', async () => {
      db.dataExportJob.findMany.mockResolvedValue([{ id: 'job-6', userId: 'user-1', status: 'queued' }]);
      db.dataExportJob.updateMany.mockResolvedValue({ count: 1 });
      db.dataExportJob.update.mockResolvedValue({});
      db.user.findUnique.mockResolvedValue(accountRow({ stellarWallet: null, creatorProfiles: [] }));

      const result = await processDataExportJobs(NOW);

      expect(result).toEqual({ completed: 1, failed: 0 });
      expect(db.dataExportJob.updateMany).toHaveBeenCalledWith({
         where: { id: 'job-6', status: 'queued' },
         data: { status: 'processing' },
      });
      expect(db.dataExportJob.update).toHaveBeenCalledWith(
         expect.objectContaining({
            where: { id: 'job-6' },
            data: expect.objectContaining({
               status: 'completed',
               completedAt: NOW,
               expiresAt: new Date(NOW.getTime() + DATA_EXPORT_LINK_TTL_MS),
            }),
         })
      );
   });

   it('marks the job failed when the archive cannot be built', async () => {
      db.dataExportJob.findMany.mockResolvedValue([{ id: 'job-7', userId: 'gone', status: 'queued' }]);
      db.dataExportJob.updateMany.mockResolvedValue({ count: 1 });
      db.dataExportJob.update.mockResolvedValue({});
      db.user.findUnique.mockResolvedValue(null);

      const result = await processDataExportJobs(NOW);

      expect(result).toEqual({ completed: 0, failed: 1 });
      expect(db.dataExportJob.update).toHaveBeenCalledWith({
         where: { id: 'job-7' },
         data: { status: 'failed', error: 'User not found' },
      });
   });

   it('skips a job another worker already claimed', async () => {
      db.dataExportJob.findMany.mockResolvedValue([{ id: 'job-8', userId: 'user-1', status: 'queued' }]);
      db.dataExportJob.updateMany.mockResolvedValue({ count: 0 });

      await expect(processDataExportJobs(NOW)).resolves.toEqual({ completed: 0, failed: 0 });
      expect(db.user.findUnique).not.toHaveBeenCalled();
   });
});
