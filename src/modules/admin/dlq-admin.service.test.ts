jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      indexerDLQ: {
         findUnique: jest.fn(),
         findMany: jest.fn(),
         updateMany: jest.fn(),
         update: jest.fn(),
         groupBy: jest.fn(),
      },
      $transaction: jest.fn(),
   },
}));

jest.mock('./audit-log.service', () => ({
   createAuditEntry: jest.fn(),
}));

jest.mock('../../utils/logger.utils', () => ({
   logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

import { prisma } from '../../utils/prisma.utils';
import { createAuditEntry } from './audit-log.service';
import { clearDlqReplayHandlers, registerDlqReplayHandler } from './dlq-replay.registry';
import {
   buildLiveDlqWhere,
   deleteDlqEntry,
   previewPayload,
   replayDlqEntry,
} from './dlq-admin.service';

const db = prisma.indexerDLQ as unknown as Record<string, jest.Mock>;
const NOW = new Date('2026-11-24T12:00:00.000Z');

function row(overrides: Record<string, unknown> = {}) {
   return {
      id: 'dlq-1',
      jobType: 'KEY_DEPTH',
      payload: { keyId: 'k1' },
      retryCount: 3,
      failureReason: 'timeout',
      errorDetails: null,
      replayCount: 0,
      lastReplayAt: null,
      lastReplayOutcome: null,
      replayedAt: null,
      createdAt: new Date('2026-11-24T11:00:00.000Z'),
      updatedAt: NOW,
      ...overrides,
   };
}

describe('dlq-admin.service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      clearDlqReplayHandlers();
      db.updateMany.mockResolvedValue({ count: 1 });
      db.update.mockResolvedValue({});
   });

   describe('buildLiveDlqWhere', () => {
      it('always excludes replayed entries and applies queue and error filters', () => {
         expect(buildLiveDlqWhere({ queue: 'KEY_DEPTH', error: 'timeout' })).toEqual({
            replayedAt: null,
            jobType: 'KEY_DEPTH',
            failureReason: { contains: 'timeout', mode: 'insensitive' },
         });
      });
   });

   describe('previewPayload', () => {
      it('truncates long payloads', () => {
         const preview = previewPayload({ data: 'x'.repeat(2000) });
         expect(preview.length).toBeLessThanOrEqual(500);
         expect(preview.endsWith('…')).toBe(true);
      });
   });

   describe('replayDlqEntry', () => {
      it('returns null when the entry does not exist', async () => {
         db.findUnique.mockResolvedValue(null);
         await expect(replayDlqEntry('missing', 'admin-1', NOW)).resolves.toBeNull();
      });

      it('marks the entry replayed when the handler succeeds', async () => {
         const handler = jest.fn().mockResolvedValue(undefined);
         registerDlqReplayHandler('KEY_DEPTH', handler);
         db.findUnique.mockResolvedValue(row());

         const result = await replayDlqEntry('dlq-1', 'admin-1', NOW);

         expect(handler).toHaveBeenCalledWith({ keyId: 'k1' });
         expect(result).toEqual({ id: 'dlq-1', outcome: 'REPLAYED' });
         expect(db.update).toHaveBeenCalledWith({
            where: { id: 'dlq-1' },
            data: { replayedAt: NOW, lastReplayOutcome: 'REPLAYED' },
         });
         expect(createAuditEntry).toHaveBeenCalledWith(
            expect.objectContaining({ actorWallet: 'admin-1', actionType: 'dlq_entry_replayed' })
         );
      });

      it('records FAILED and keeps the entry live when the handler throws', async () => {
         registerDlqReplayHandler('KEY_DEPTH', jest.fn().mockRejectedValue(new Error('rpc down')));
         db.findUnique.mockResolvedValue(row());

         const result = await replayDlqEntry('dlq-1', 'admin-1', NOW);

         expect(result).toEqual({ id: 'dlq-1', outcome: 'FAILED', error: 'rpc down' });
         expect(db.update).toHaveBeenCalledWith({
            where: { id: 'dlq-1' },
            data: { lastReplayOutcome: 'FAILED: rpc down' },
         });
         expect(db.update.mock.calls[0][0].data).not.toHaveProperty('replayedAt');
      });

      it('records NO_HANDLER when no handler is registered for the job type', async () => {
         db.findUnique.mockResolvedValue(row());

         const result = await replayDlqEntry('dlq-1', 'admin-1', NOW);

         expect(result).toEqual({ id: 'dlq-1', outcome: 'NO_HANDLER' });
         expect(db.update).toHaveBeenCalledWith({
            where: { id: 'dlq-1' },
            data: { lastReplayOutcome: 'NO_HANDLER' },
         });
      });

      it('does not run the handler when another replay already claimed the entry', async () => {
         const handler = jest.fn();
         registerDlqReplayHandler('KEY_DEPTH', handler);
         db.findUnique.mockResolvedValue(row());
         db.updateMany.mockResolvedValue({ count: 0 });

         const result = await replayDlqEntry('dlq-1', 'admin-1', NOW);

         expect(result).toEqual({ id: 'dlq-1', outcome: 'ALREADY_REPLAYED' });
         expect(handler).not.toHaveBeenCalled();
      });

      it('claims with the observed replayCount so a stale snapshot cannot replay twice', async () => {
         db.findUnique.mockResolvedValue(row({ replayCount: 2 }));
         await replayDlqEntry('dlq-1', 'admin-1', NOW);

         expect(db.updateMany).toHaveBeenCalledWith({
            where: { id: 'dlq-1', replayedAt: null, replayCount: 2 },
            data: { replayCount: { increment: 1 }, lastReplayAt: NOW },
         });
      });
   });

   describe('deleteDlqEntry', () => {
      it('deletes and writes the audit record in one transaction', async () => {
         const tx = {
            indexerDLQ: {
               findUnique: jest.fn().mockResolvedValue(row()),
               delete: jest.fn().mockResolvedValue({}),
            },
            auditLog: { create: jest.fn().mockResolvedValue({}) },
         };
         (prisma.$transaction as unknown as jest.Mock).mockImplementation(
            async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)
         );

         const deleted = await deleteDlqEntry('dlq-1', 'duplicate of INC-42 cleanup', 'admin-1');

         expect(deleted).toBe(true);
         expect(tx.indexerDLQ.delete).toHaveBeenCalledWith({ where: { id: 'dlq-1' } });
         expect(tx.auditLog.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
               actorWallet: 'admin-1',
               actionType: 'dlq_entry_deleted',
               targetId: 'dlq-1',
               payload: expect.objectContaining({
                  reason: 'duplicate of INC-42 cleanup',
                  jobType: 'KEY_DEPTH',
               }),
            }),
         });
      });

      it('returns false and deletes nothing when the entry is missing', async () => {
         const tx = {
            indexerDLQ: { findUnique: jest.fn().mockResolvedValue(null), delete: jest.fn() },
            auditLog: { create: jest.fn() },
         };
         (prisma.$transaction as unknown as jest.Mock).mockImplementation(
            async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)
         );

         await expect(deleteDlqEntry('nope', 'reason text here', 'admin-1')).resolves.toBe(false);
         expect(tx.indexerDLQ.delete).not.toHaveBeenCalled();
         expect(tx.auditLog.create).not.toHaveBeenCalled();
      });
   });
});
