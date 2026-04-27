import { AsyncController } from '../../types/auth.types';
import { sendSuccess, sendValidationError, sendNotFound } from '../../utils/api-response.utils';
import { prisma } from '../../utils/prisma.utils';
import { emitAuditEvent } from '../../utils/audit.utils';
import { AdminRequest } from '../../middlewares/admin-guard.middleware';
import { Response } from 'express';
import { z } from 'zod';

const UpdateCreatorMetadataSchema = z.object({
  isVerified: z.boolean().optional(),
});

type UpdateCreatorMetadataInput = z.infer<typeof UpdateCreatorMetadataSchema>;

export const httpUpdateCreatorMetadata: AsyncController = async (req, res, next) => {
  try {
    const { id } = req.params as { id: string };
    const adminIdHeader = req.headers['x-admin-id'];
    const actorId =
      typeof adminIdHeader === 'string'
        ? adminIdHeader
        : Array.isArray(adminIdHeader)
          ? adminIdHeader[0]
          : undefined;

    if (!id || !actorId) {
      return sendValidationError(res, 'Missing required parameters', [
        { field: 'id', message: 'Creator ID is required' },
        { field: 'x-admin-id', message: 'Admin ID header is required' },
      ]);
    }

    const parsed = UpdateCreatorMetadataSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendValidationError(res, 'Invalid request body', [
        { field: 'body', message: 'Invalid metadata update' },
      ]);
    }

    const updates = parsed.data as UpdateCreatorMetadataInput;

    const creator = await prisma.creatorProfile.findUnique({
      where: { id },
    });

    if (!creator) {
      return sendNotFound(res, 'Creator');
    }

    const previousValues = {
      isVerified: creator.isVerified,
    };

    const updated = await prisma.creatorProfile.update({
      where: { id },
      data: updates,
    });

    const changes: Record<string, unknown> = {};
    Object.entries(updates).forEach(([key, value]) => {
      if (value !== previousValues[key as keyof typeof previousValues]) {
        changes[key] = {
          before: previousValues[key as keyof typeof previousValues],
          after: value,
        };
      }
    });

    if (Object.keys(changes).length > 0) {
      await emitAuditEvent({
        actor: actorId,
        action: 'update_creator_metadata',
        target: 'CreatorProfile',
        targetId: id,
        metadata: changes,
      });
    }

    sendSuccess(res, updated);
  } catch (error) {
    next(error);
  }
};

export const httpReplayIndexerEvents: AsyncController = async (req: AdminRequest, res: Response, next) => {
  try {
    const { startLedger } = req.body as { startLedger?: number };
    const adminId = req.adminId;

    if (typeof startLedger !== 'number' || startLedger < 1) {
      return sendValidationError(res, 'Invalid request body', [
        { field: 'startLedger', message: 'startLedger must be a positive integer' },
      ]);
    }

    const replayInitiated = {
      type: 'INDEXER_REPLAY_INITIATED',
      startLedger,
      initiatedBy: adminId,
      timestamp: new Date().toISOString(),
    };

    await emitAuditEvent({
      actor: adminId || 'unknown',
      action: 'replay_indexer_events',
      target: 'IndexerQueue',
      targetId: String(startLedger),
      metadata: { startLedger },
    });

    sendSuccess(res, replayInitiated);
  } catch (error) {
    next(error);
  }
};
