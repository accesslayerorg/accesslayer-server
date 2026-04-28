import { AsyncController } from '../../types/auth.types';
import {
   sendSuccess,
   sendValidationError,
   sendNotFound,
   sendForbidden,
} from '../../utils/api-response.utils';
import { prisma } from '../../utils/prisma.utils';
import { emitAuditEvent } from '../../utils/audit.utils';
import { AdminRequest } from '../../middlewares/admin-guard.middleware';
import { Response } from 'express';
import { z } from 'zod';
import { acquireJobLock } from '../../utils/background-job-lock.utils';
import { logger } from '../../utils/logger.utils';
import { ErrorCode } from '../../constants/error.constants';

const UpdateCreatorMetadataSchema = z.object({
   isVerified: z.boolean().optional(),
});

type UpdateCreatorMetadataInput = z.infer<typeof UpdateCreatorMetadataSchema>;

export const httpUpdateCreatorMetadata: AsyncController = async (
   req,
   res,
   next
) => {
   try {
      const { id } = req.params as { id: string };
      const adminIdHeader = req.headers['x-admin-id'];
      const actorId =
         typeof adminIdHeader === 'string'
            ? adminIdHeader
            : Array.isArray(adminIdHeader)
              ? adminIdHeader[0]
              : undefined;

      if (!actorId) {
         return sendForbidden(res, 'Admin access required', [
            { field: 'x-admin-id', message: 'Admin ID header is required' },
         ]);
      }

      if (!id) {
         return sendValidationError(res, 'Missing required parameters', [
            { field: 'id', message: 'Creator ID is required' },
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
    const { startLedger, dryRun = false } = req.body as { startLedger?: number; dryRun?: boolean };
    const adminId = req.adminId;
    const lockName = 'indexer-replay';
    const lockOwner = adminId || 'unknown';

    if (typeof startLedger !== 'number' || startLedger < 1) {
      return sendValidationError(res, 'Invalid request body', [
        { field: 'startLedger', message: 'startLedger must be a positive integer' },
      ]);
    }
    if (typeof dryRun !== 'boolean') {
      return sendValidationError(res, 'Invalid request body', [
        { field: 'dryRun', message: 'dryRun must be a boolean' },
      ]);
    }

    const lock = acquireJobLock({
      name: lockName,
      owner: lockOwner,
    });

    if (!lock.acquired) {
      return res.status(409).json({
        success: false,
        error: {
          code: ErrorCode.CONFLICT,
          message: 'Indexer replay job is already running',
          details: [
            {
              field: 'indexerReplayLock',
              message: `Lock is held by ${lock.holder || 'another worker'} until ${lock.expiresAt || 'unknown time'}`,
            },
          ],
        },
      });
    }

    const replayInitiated = {
      type: 'INDEXER_REPLAY_INITIATED',
      startLedger,
      dryRun,
      initiatedBy: adminId,
      lock: {
        name: lockName,
        expiresAt: lock.expiresAt,
      },
      timestamp: new Date().toISOString(),
    };

    logger.info(
      {
        lockName,
        lockOwner,
        lockExpiresAt: lock.expiresAt,
      },
      'Acquired background job lock for indexer replay'
    );

    if (!dryRun) {
      await emitAuditEvent({
        actor: adminId || 'unknown',
        action: 'replay_indexer_events',
        target: 'IndexerQueue',
        targetId: String(startLedger),
        metadata: { startLedger, dryRun },
      });
    }

    sendSuccess(res, replayInitiated);
  } catch (error) {
    next(error);
  }
};
