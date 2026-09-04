import { AsyncController } from '../../types/auth.types';
import {
   sendSuccess,
   sendValidationError,
   sendCreatorParamNotFound,
   sendForbidden,
   sendError,
} from '../../utils/api-response.utils';
import { prisma } from '../../utils/prisma.utils';
import { emitAuditEvent } from '../../utils/audit.utils';
import { createAuditEntry } from './audit-log.service';
import { AdminRequest } from '../../middlewares/admin-guard.middleware';
import { Response } from 'express';
import { z } from 'zod';
import { acquireJobLock } from '../../utils/background-job-lock.utils';
import { logger } from '../../utils/logger.utils';
import { ErrorCode } from '../../constants/error.constants';
import { updateProtocolFeeBps } from '../keys/key-fees.service';

const UpdateCreatorMetadataSchema = z.object({
   isVerified: z.boolean().optional(),
   tradingPaused: z.boolean().optional(),
});

type UpdateCreatorMetadataInput = z.infer<typeof UpdateCreatorMetadataSchema>;

const GetAuditLogSchema = z.object({
   limit: z.coerce.number().int().positive().max(100).optional().default(50),
   cursor: z.string().optional(),
   actionType: z.string().optional(),
});

type GetAuditLogInput = z.infer<typeof GetAuditLogSchema>;

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
         return sendCreatorParamNotFound(res);
      }

      const previousValues = {
         isVerified: creator.isVerified,
         tradingPaused: creator.tradingPaused,
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
         const action =
            'tradingPaused' in changes
               ? changes.tradingPaused && (changes.tradingPaused as any).after === true
                  ? 'pause_creator_trading'
                  : 'resume_creator_trading'
               : 'update_creator_metadata';
         await emitAuditEvent({
            actor: actorId,
            action,
            target: 'CreatorProfile',
            targetId: id,
            metadata: changes,
         });

         // Log to queryable audit log
         await createAuditEntry({
            actorWallet: actorId,
            actionType: 'update_creator_metadata',
            targetId: id,
            payload: changes,
         });
      }

      sendSuccess(res, updated);
   } catch (error) {
      next(error);
   }
};

export const httpReplayIndexerEvents: AsyncController = async (
   req: AdminRequest,
   res: Response,
   next
) => {
   try {
      const {
         startLedger,
         endLedger,
         dryRun = false,
      } = req.body as {
         startLedger?: number;
         endLedger?: number;
         dryRun?: boolean;
      };
      const adminId = req.adminId;
      const lockName = 'indexer-replay';
      const lockOwner = adminId || 'unknown';

      if (typeof startLedger !== 'number' || startLedger < 1) {
         return sendValidationError(res, 'Invalid request body', [
            {
               field: 'startLedger',
               message: 'startLedger must be a positive integer',
            },
         ]);
      }

      if (
         endLedger !== undefined &&
         (typeof endLedger !== 'number' || endLedger < startLedger)
      ) {
         return sendValidationError(res, 'Invalid request body', [
            { field: 'endLedger', message: 'endLedger must be >= startLedger' },
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
         return sendError(
            res,
            409,
            ErrorCode.CONFLICT,
            'Indexer replay job is already running',
            [
               {
                  field: 'indexerReplayLock',
                  message: `Lock is held by ${lock.holder || 'another worker'} until ${lock.expiresAt || 'unknown time'}`,
               },
            ]
         );
      }

      const replayInitiated = {
         type: 'INDEXER_REPLAY_INITIATED',
         startLedger,
         endLedger: endLedger || null,
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
            startLedger,
            endLedger: endLedger || null,
         },
         'Acquired background job lock for indexer replay'
      );

      if (!dryRun) {
         await emitAuditEvent({
            actor: adminId || 'unknown',
            action: 'replay_indexer_events',
            target: 'IndexerQueue',
            targetId: String(startLedger),
            metadata: { startLedger, endLedger: endLedger || null, dryRun },
         });

         // Log to queryable audit log
         await createAuditEntry({
            actorWallet: adminId || 'unknown',
            actionType: 'replay_indexer_events',
            targetId: String(startLedger),
            payload: { startLedger, endLedger: endLedger || null, dryRun },
         });
      }

      sendSuccess(res, replayInitiated);
   } catch (error) {
      next(error);
   }
};

const UpdateProtocolFeeSchema = z.object({
   protocolFeeBps: z.number().int().min(0).max(10000),
});

export const httpUpdateProtocolFee = async (
   req: AdminRequest,
   res: Response,
   next: (error: unknown) => void
): Promise<void> => {
   try {
      const parsed = UpdateProtocolFeeSchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(res, 'Invalid request body', [
            { field: 'protocolFeeBps', message: 'Must be an integer 0–10000' },
         ]);
         return;
      }

      const updated = await updateProtocolFeeBps(parsed.data.protocolFeeBps);

      await emitAuditEvent({
         actor: req.adminId || 'unknown',
         action: 'protocol_fee_updated',
         target: 'ProtocolConfig',
         targetId: 'default',
         metadata: { protocolFeeBps: updated.protocolFeeBps },
      });

      // Log to queryable audit log
      await createAuditEntry({
         actorWallet: req.adminId || 'unknown',
         actionType: 'protocol_fee_updated',
         targetId: 'default',
         payload: { protocolFeeBps: updated.protocolFeeBps },
      });

      sendSuccess(res, updated);
   } catch (error) {
      next(error);
   }
};

export const httpSetKeyTradingPaused = async (
   req: AdminRequest,
   res: Response,
   next: (error: unknown) => void
): Promise<void> => {
   try {
      const creatorId = String(req.params.keyId);
      const tradingPaused = req.path.endsWith('/pause');
      const creator = await prisma.creatorProfile.findUnique({
         where: { id: creatorId },
         select: { id: true, tradingPaused: true },
      });
      if (!creator) {
         sendCreatorParamNotFound(res);
         return;
      }
      const updated = await prisma.creatorProfile.update({
         where: { id: creatorId },
         data: { tradingPaused },
      });
      if (creator.tradingPaused !== tradingPaused) {
         const actionType = tradingPaused
            ? 'key_trading_paused'
            : 'key_trading_resumed';
         await emitAuditEvent({
            actor: req.adminId!,
            action: actionType,
            target: 'CreatorKey',
            targetId: creatorId,
         });

         // Log to queryable audit log
         await createAuditEntry({
            actorWallet: req.adminId!,
            actionType,
            targetId: creatorId,
            payload: { tradingPaused },
         });
      }
      sendSuccess(res, updated);
   } catch (error) {
      next(error);
   }
};

export const httpGetAuditLog: AsyncController = async (
   req: AdminRequest,
   res: Response,
   next
) => {
   try {
      const parsed = GetAuditLogSchema.safeParse(req.query);
      if (!parsed.success) {
         return sendValidationError(res, 'Invalid query parameters', [
            {
               field: 'query',
               message: 'Invalid pagination or filter parameters',
            },
         ]);
      }

      const input = parsed.data as GetAuditLogInput;
      const { getAuditLogs } = await import('./audit-log.service');

      const result = await getAuditLogs({
         limit: input.limit,
         cursor: input.cursor,
         actionType: input.actionType,
      });

      sendSuccess(res, {
         entries: result.entries,
         pagination: {
            limit: input.limit,
            cursor: input.cursor,
            nextCursor: result.nextCursor,
            hasMore: result.hasMore,
         },
      });
   } catch (error) {
      next(error);
   }
};
