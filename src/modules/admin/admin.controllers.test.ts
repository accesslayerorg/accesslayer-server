import { httpReplayIndexerEvents } from './admin.controllers';
import { emitAuditEvent } from '../../utils/audit.utils';
import { AdminRequest } from '../../middlewares/admin-guard.middleware';
import { Response } from 'express';

jest.mock('../../utils/background-job-lock.utils', () => ({
  acquireJobLock: jest.fn(() => ({
    acquired: true,
    expiresAt: '2026-01-01T00:00:00.000Z',
  })),
}));

jest.mock('../../utils/prisma.utils', () => ({
  prisma: {
    creatorProfile: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock('../../utils/audit.utils', () => ({
  emitAuditEvent: jest.fn(),
}));

describe('httpReplayIndexerEvents', () => {
  const next = jest.fn();

  const createRes = (): Response =>
    ({
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    }) as unknown as Response;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns validation error when dryRun is not a boolean', async () => {
    const req = {
      body: { startLedger: 10, dryRun: 'true' },
      adminId: 'admin-1',
    } as unknown as AdminRequest;
    const res = createRes();

    await httpReplayIndexerEvents(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({
          message: 'Invalid request body',
          details: expect.arrayContaining([expect.objectContaining({ field: 'dryRun' })]),
        }),
      })
    );
    expect(emitAuditEvent).not.toHaveBeenCalled();
  });

  it('does not emit audit event when dryRun=true', async () => {
    const req = {
      body: { startLedger: 20, dryRun: true },
      adminId: 'admin-2',
    } as unknown as AdminRequest;
    const res = createRes();

    await httpReplayIndexerEvents(req, res, next);

    expect(emitAuditEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          type: 'INDEXER_REPLAY_INITIATED',
          startLedger: 20,
          dryRun: true,
          initiatedBy: 'admin-2',
        }),
      })
    );
  });

  it('emits audit event when dryRun=false', async () => {
    const req = {
      body: { startLedger: 30, dryRun: false },
      adminId: 'admin-3',
    } as unknown as AdminRequest;
    const res = createRes();

    await httpReplayIndexerEvents(req, res, next);

    expect(emitAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'admin-3',
        action: 'replay_indexer_events',
        targetId: '30',
        metadata: expect.objectContaining({ startLedger: 30, dryRun: false }),
      })
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
