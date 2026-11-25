jest.mock('../../config', () => ({
   envConfig: { JWT_SECRET: 'x'.repeat(48), BACKEND_URL: 'https://api.example.test' },
}));
jest.mock('../../utils/logger.utils', () => ({
   logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      user: { findUnique: jest.fn() },
      limitOrder: { count: jest.fn(), updateMany: jest.fn() },
      scheduledTransfer: { count: jest.fn() },
      autoInvestRule: { count: jest.fn(), deleteMany: jest.fn() },
      keyLpPosition: { findMany: jest.fn() },
      revenueClaim: { count: jest.fn() },
      dividendClaim: { count: jest.fn() },
      deletionRequest: {
         findFirst: jest.fn(),
         findMany: jest.fn(),
         create: jest.fn(),
         update: jest.fn(),
         updateMany: jest.fn(),
      },
      $transaction: jest.fn(),
      priceAlert: { deleteMany: jest.fn() },
      investorWatchlist: { deleteMany: jest.fn() },
      comment: { updateMany: jest.fn() },
      stellarWallet: { deleteMany: jest.fn() },
      creatorProfile: { update: jest.fn() },
      dataExportJob: { updateMany: jest.fn() },
   },
}));

import { prisma } from '../../utils/prisma.utils';
import {
   anonymizeAccount,
   cancelAccountDeletion,
   DeletionBlockedError,
   DeletionGracePeriodEndedError,
   findDeletionBlockers,
   NoPendingDeletionError,
   processDueDeletions,
   requestAccountDeletion,
} from './account-deletion.service';
import { DELETION_GRACE_PERIOD_MS } from './account.constants';

const db = prisma as unknown as Record<string, Record<string, jest.Mock>>;
const WALLET = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const NOW = new Date('2026-11-24T12:00:00Z');

function clearBlockers() {
   db.limitOrder.count.mockResolvedValue(0);
   db.scheduledTransfer.count.mockResolvedValue(0);
   db.autoInvestRule.count.mockResolvedValue(0);
   db.keyLpPosition.findMany.mockResolvedValue([]);
   db.revenueClaim.count.mockResolvedValue(0);
   db.dividendClaim.count.mockResolvedValue(0);
}

beforeEach(() => {
   jest.clearAllMocks();
   clearBlockers();
});

describe('findDeletionBlockers', () => {
   it('returns no blockers for a wallet with nothing outstanding', async () => {
      await expect(findDeletionBlockers(WALLET)).resolves.toEqual([]);
   });

   it('reports open orders, active plans and unclaimed earnings', async () => {
      db.limitOrder.count.mockResolvedValue(2);
      db.scheduledTransfer.count.mockResolvedValue(1);
      db.autoInvestRule.count.mockResolvedValue(1);
      db.keyLpPosition.findMany.mockResolvedValue([
         {
            accruedRewards: { minus: () => ({ greaterThan: () => true }) },
            claimedRewards: {},
         },
      ]);
      db.revenueClaim.count.mockResolvedValue(1);

      const blockers = await findDeletionBlockers(WALLET);

      expect(blockers.map(b => [b.code, b.count])).toEqual([
         ['open_orders', 2],
         ['active_plans', 2],
         ['unclaimed_earnings', 2],
      ]);
      expect(db.limitOrder.count).toHaveBeenCalledWith({
         where: { wallet: WALLET, status: { in: ['OPEN', 'EXECUTABLE'] } },
      });
   });

   it('does not block when there is no wallet', async () => {
      await expect(findDeletionBlockers(null)).resolves.toEqual([]);
      expect(db.limitOrder.count).not.toHaveBeenCalled();
   });
});

describe('requestAccountDeletion', () => {
   it('refuses while the account has outstanding obligations', async () => {
      db.user.findUnique.mockResolvedValue({ id: 'user-1', stellarWallet: { address: WALLET } });
      db.deletionRequest.findFirst.mockResolvedValue(null);
      db.limitOrder.count.mockResolvedValue(1);

      await expect(requestAccountDeletion('user-1', NOW)).rejects.toBeInstanceOf(DeletionBlockedError);
      expect(db.deletionRequest.create).not.toHaveBeenCalled();
   });

   it('schedules deletion after the 14-day grace period', async () => {
      db.user.findUnique.mockResolvedValue({ id: 'user-1', stellarWallet: { address: WALLET } });
      db.deletionRequest.findFirst.mockResolvedValue(null);
      db.deletionRequest.create.mockImplementation(async ({ data }) => ({
         id: 'req-1',
         ...data,
         requestedAt: NOW,
         cancelledAt: null,
         completedAt: null,
      }));

      const view = await requestAccountDeletion('user-1', NOW);

      const created = db.deletionRequest.create.mock.calls[0][0].data;
      expect(created.scheduledFor).toEqual(new Date(NOW.getTime() + DELETION_GRACE_PERIOD_MS));
      expect(created.pseudonymId).toMatch(/^anon_[0-9a-f]{24}$/);
      expect(view).toMatchObject({ id: 'req-1', status: 'pending' });
   });
});

describe('cancelAccountDeletion', () => {
   it('cancels a pending deletion inside the grace period', async () => {
      db.deletionRequest.findFirst.mockResolvedValue({
         id: 'req-2',
         status: 'pending',
         scheduledFor: new Date(NOW.getTime() + 1000),
         requestedAt: NOW,
         cancelledAt: null,
         completedAt: null,
      });
      db.deletionRequest.updateMany.mockResolvedValue({ count: 1 });

      const view = await cancelAccountDeletion('user-1', NOW);

      expect(db.deletionRequest.updateMany).toHaveBeenCalledWith({
         where: { id: 'req-2', status: 'pending' },
         data: { status: 'cancelled', cancelledAt: NOW },
      });
      expect(view.status).toBe('cancelled');
   });

   it('refuses once the grace period has ended', async () => {
      db.deletionRequest.findFirst.mockResolvedValue({
         id: 'req-3',
         status: 'pending',
         scheduledFor: new Date(NOW.getTime() - 1),
         requestedAt: NOW,
      });
      await expect(cancelAccountDeletion('user-1', NOW)).rejects.toBeInstanceOf(DeletionGracePeriodEndedError);
   });

   it('reports when there is nothing to cancel', async () => {
      db.deletionRequest.findFirst.mockResolvedValue(null);
      await expect(cancelAccountDeletion('user-1', NOW)).rejects.toBeInstanceOf(NoPendingDeletionError);
   });
});

describe('anonymizeAccount', () => {
   it('replaces personal fields, re-keys wallet records and unlinks the wallet', async () => {
      const tx = {
         user: { update: jest.fn() },
         creatorProfile: { update: jest.fn() },
         dataExportJob: { updateMany: jest.fn() },
         comment: { updateMany: jest.fn() },
         limitOrder: { updateMany: jest.fn() },
         priceAlert: { deleteMany: jest.fn() },
         investorWatchlist: { deleteMany: jest.fn() },
         autoInvestRule: { deleteMany: jest.fn() },
         stellarWallet: { deleteMany: jest.fn() },
         deletionRequest: { update: jest.fn() },
      };
      db.$transaction.mockImplementation(async (callback: (t: typeof tx) => unknown) => callback(tx));
      db.user.findUnique.mockResolvedValue({
         id: 'user-1',
         stellarWallet: { address: WALLET },
         creatorProfiles: [{ id: 'creator-1' }],
      });

      await anonymizeAccount({ id: 'req-4', userId: 'user-1', pseudonymId: 'anon_abc' }, NOW);

      expect(tx.user.update).toHaveBeenCalledWith(
         expect.objectContaining({
            where: { id: 'user-1' },
            data: expect.objectContaining({
               email: 'deleted+anon_abc@deleted.invalid',
               firstName: 'Deleted',
               passwordHash: 'deleted:anon_abc',
            }),
         })
      );
      expect(tx.creatorProfile.update).toHaveBeenCalledWith(
         expect.objectContaining({ data: expect.objectContaining({ handle: 'deleted-creator-1' }) })
      );
      expect(tx.comment.updateMany).toHaveBeenCalledWith({
         where: { author: WALLET },
         data: { author: 'anon_abc', body: '[deleted]' },
      });
      expect(tx.limitOrder.updateMany).toHaveBeenCalledWith({
         where: { wallet: WALLET },
         data: { wallet: 'anon_abc' },
      });
      expect(tx.stellarWallet.deleteMany).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
      expect(tx.deletionRequest.update).toHaveBeenCalledWith({
         where: { id: 'req-4' },
         data: { status: 'completed', completedAt: NOW, error: null },
      });
   });
});

describe('processDueDeletions', () => {
   it('anonymizes a due account that has no obligations', async () => {
      db.deletionRequest.findMany.mockResolvedValue([{ id: 'req-5', userId: 'user-1', pseudonymId: 'anon_x' }]);
      db.deletionRequest.updateMany.mockResolvedValue({ count: 1 });
      db.user.findUnique.mockResolvedValue({ id: 'user-1', stellarWallet: null, creatorProfiles: [] });
      db.$transaction.mockImplementation(async (callback: (t: unknown) => unknown) =>
         callback({
            user: { update: jest.fn() },
            dataExportJob: { updateMany: jest.fn() },
            stellarWallet: { deleteMany: jest.fn() },
            deletionRequest: { update: jest.fn() },
         })
      );

      await expect(processDueDeletions(NOW)).resolves.toEqual({ completed: 1, deferred: 0, failed: 0 });
      expect(db.deletionRequest.updateMany).toHaveBeenCalledWith({
         where: { id: 'req-5', status: 'pending' },
         data: { status: 'processing' },
      });
   });

   it('defers an account that gained an obligation during the grace period', async () => {
      db.deletionRequest.findMany.mockResolvedValue([{ id: 'req-6', userId: 'user-1', pseudonymId: 'anon_y' }]);
      db.deletionRequest.updateMany.mockResolvedValue({ count: 1 });
      db.user.findUnique.mockResolvedValue({ id: 'user-1', stellarWallet: { address: WALLET } });
      db.limitOrder.count.mockResolvedValue(1);

      await expect(processDueDeletions(NOW)).resolves.toEqual({ completed: 0, deferred: 1, failed: 0 });
      expect(db.$transaction).not.toHaveBeenCalled();
      expect(db.deletionRequest.update).toHaveBeenCalledWith({
         where: { id: 'req-6' },
         data: expect.objectContaining({ status: 'pending', error: expect.stringContaining('Deferred') }),
      });
   });
});
