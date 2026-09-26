import { Router } from 'express';
import { z } from 'zod';
import {
   httpUpdateCreatorMetadata,
   httpReplayIndexerEvents,
   httpSetKeyTradingPaused,
   httpUpdateProtocolFee,
   httpGetAuditLog,
} from './admin.controllers';
import { httpSyncKeyState } from './key-sync.controllers';
import { getKeySnapshot, KeySnapshotNotFoundError } from './key-snapshot.service';
import { createAuditEntry } from './audit-log.service';
import { invalidateProtocolStatusCache } from '../protocol/protocol.routes';
import {
   analyticsWindowQuerySchema,
   getPlatformAnalytics,
} from '../keys/key-analytics.service';
import { getProtocolLpOverview } from './lp-overview.service';
import {
   adminGuard,
   AdminRequest,
} from '../../middlewares/admin-guard.middleware';
import {
   requireKeyCreator,
   AuthenticatedRequest,
} from '../../middlewares/jwt-auth.middleware';
import {
   sendError,
   sendNotFound,
   sendSuccess,
   sendValidationError,
   sendConflict,
   sendForbidden,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';

function isValidStellarAddress(address: string): boolean {
   return typeof address === 'string' && /^G[A-Z2-7]{55}$/.test(address);
}

function formatCountdown(ms: number): string {
   if (!Number.isFinite(ms) || ms <= 0) {
      return '0s';
   }

   const totalSeconds = Math.ceil(ms / 1000);
   const days = Math.floor(totalSeconds / 86400);
   const hours = Math.floor((totalSeconds % 86400) / 3600);
   const minutes = Math.floor((totalSeconds % 3600) / 60);
   const seconds = totalSeconds % 60;
   const parts: string[] = [];

   if (days > 0) parts.push(`${days}d`);
   if (hours > 0) parts.push(`${hours}h`);
   if (minutes > 0) parts.push(`${minutes}m`);
   if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);

   return parts.join(' ');
}

function getTimelockEventType(status: string): 'ActionProposed' | 'ActionExecuted' | 'ActionCancelled' {
   switch (status) {
      case 'executed':
         return 'ActionExecuted';
      case 'cancelled':
         return 'ActionCancelled';
      default:
         return 'ActionProposed';
   }
}

function serializeTimelockAction(action: any) {
   const executionNotBefore = action.executionNotBefore
      ? new Date(action.executionNotBefore)
      : null;
   const executedAt = action.executedAt ? new Date(action.executedAt) : null;
   const executionTimestamp = executedAt ?? executionNotBefore;
   const countdownMs =
      action.status === 'pending' && executionNotBefore
         ? Math.max(0, executionNotBefore.getTime() - Date.now())
         : null;

   return {
      proposalId: action.proposalId,
      changeType: action.changeType,
      payload: action.payload ?? {},
      status: action.status,
      eventType: getTimelockEventType(action.status),
      createdAt: action.createdAt ? new Date(action.createdAt).toISOString() : null,
      executionTimestamp: executionTimestamp ? executionTimestamp.toISOString() : null,
      executionNotBefore: executionNotBefore ? executionNotBefore.toISOString() : null,
      executedAt: executedAt ? executedAt.toISOString() : null,
      cancelledAt:
         action.status === 'cancelled' && action.createdAt
            ? new Date(action.createdAt).toISOString()
            : null,
      ...(countdownMs !== null
         ? {
             countdownMs,
             countdown: formatCountdown(countdownMs),
          }
         : {}),
   };
}

const adminRouter = Router();

adminRouter.patch('/creators/:id/metadata', httpUpdateCreatorMetadata);
adminRouter.post('/indexer/replay', adminGuard, httpReplayIndexerEvents);
adminRouter.post('/keys/:keyId/pause', adminGuard, httpSetKeyTradingPaused);
adminRouter.post('/keys/:keyId/resume', adminGuard, httpSetKeyTradingPaused);
adminRouter.post('/keys/:keyId/sync', adminGuard, httpSyncKeyState);
adminRouter.patch('/protocol-fee', adminGuard, httpUpdateProtocolFee);
adminRouter.get('/audit-log', adminGuard, httpGetAuditLog);

/**
 * GET /api/v1/admin/analytics?from=&to=
 *
 * Platform-wide trade count, unique traders, total volume, and number of
 * traded keys for the admin dashboard. Cached 60s per window (#916).
 */
adminRouter.get('/analytics', adminGuard, async (req: AdminRequest, res, next) => {
   const parsed = analyticsWindowQuerySchema.safeParse(req.query);
   if (!parsed.success) {
      sendValidationError(
         res,
         'Invalid analytics query',
         zodIssuesToDetails(parsed.error.issues)
      );
      return;
   }
   try {
      sendSuccess(res, await getPlatformAnalytics(parsed.data));
   } catch (error) {
      logger.error({ error }, 'Platform analytics failed');
      next(error);
   }
});

/**
 * GET /api/v1/admin/lp-overview
 *
 * Protocol-owned liquidity across all keys: total LP XLM contributed, the
 * number of keys holding LP, and the number of allocation events. Sourced
 * from LPAllocationSent contract events. Cached 60s (#943).
 */
adminRouter.get('/lp-overview', adminGuard, async (_req: AdminRequest, res, next) => {
   try {
      sendSuccess(res, await getProtocolLpOverview());
   } catch (error) {
      logger.error({ error }, 'LP overview failed');
      next(error);
   }
});

/**
 * GET /api/v1/admin/keys/:keyId/snapshot
 *
 * Returns a full on-chain state snapshot for a key alongside the matching
 * database values, with a `drift` boolean per field. Requires a valid admin
 * JWT. Returns 404 for unknown key IDs.
 */
adminRouter.get('/keys/:keyId/snapshot', adminGuard, async (req: AdminRequest, res, next) => {
   try {
      const keyId = String(req.params.keyId);
      const snapshot = await getKeySnapshot(keyId);
      sendSuccess(res, snapshot);
   } catch (error) {
      if (error instanceof KeySnapshotNotFoundError) {
         sendNotFound(res, 'Key');
         return;
      }
      logger.error(
         { error, keyId: req.params.keyId },
         'Key snapshot failed'
      );
      next(error);
   }
});

/**
 * POST /api/v1/admin/vesting
 * Add a vesting schedule creation endpoint for admins (#835).
 */
adminRouter.post('/vesting', adminGuard, async (req: AdminRequest, res, next) => {
   const { keyId, beneficiary, totalKeys, startLedger } = req.body || {};

   if (totalKeys === undefined || totalKeys === null || typeof totalKeys !== 'number' || totalKeys <= 0) {
      sendError(res, 422, ErrorCode.UNPROCESSABLE_ENTITY, 'totalKeys must be a positive number');
      return;
   }

   // Fixed function call from isValidStellarContractAddress to isValidStellarAddress
   if (!beneficiary || !isValidStellarAddress(beneficiary)) {
      sendError(res, 422, ErrorCode.UNPROCESSABLE_ENTITY, 'Invalid beneficiary address');
      return;
   }

   if (!keyId || startLedger === undefined) {
      sendError(res, 422, ErrorCode.UNPROCESSABLE_ENTITY, 'keyId and startLedger are required');
      return;
   }

   try {
      const vestingPeriodSeconds = 90 * 24 * 60 * 60; // 90 days
      const endLedger = Number(startLedger) + Math.floor(vestingPeriodSeconds / 5);
      const vestingEndsAt = new Date(Date.now() + vestingPeriodSeconds * 1000);

      const schedule = await prisma.vestingSchedule.create({
         data: {
            keyId: String(keyId),
            wallet: String(beneficiary),
            totalKeys: new Prisma.Decimal(totalKeys),
            startLedger: Number(startLedger),
            endLedger,
            claimedKeys: new Prisma.Decimal(0),
         },
      });

      sendSuccess(res, {
         ...schedule,
         totalKeys: Number(schedule.totalKeys),
         claimedKeys: Number(schedule.claimedKeys),
         vestingEndsAt: vestingEndsAt.toISOString(),
      });
   } catch (error) {
      next(error);
   }
});

/**
 * POST /api/v1/admin/protocol/fee
 * Add a protocol fee update endpoint for admins (#839).
 */
adminRouter.post('/protocol/fee', adminGuard, async (req: AdminRequest, res, next) => {
   const { feeBps, treasuryAddress } = req.body || {};

   if (feeBps === undefined || feeBps === null || typeof feeBps !== 'number' || feeBps < 0 || feeBps > 1000) {
      sendError(res, 422, ErrorCode.UNPROCESSABLE_ENTITY, 'feeBps must be between 0 and 1000');
      return;
   }

   if (!treasuryAddress || !isValidStellarAddress(treasuryAddress)) {
      sendError(res, 422, ErrorCode.UNPROCESSABLE_ENTITY, 'Invalid treasury address');
      return;
   }

   try {
      const executionNotBefore = new Date(Date.now() + 48 * 60 * 60 * 1000);
      const proposalId = `tl-fee-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const proposal = await prisma.timelockProposal.create({
         data: {
            proposalId,
            changeType: 'update_fee',
            payload: { feeBps, treasuryAddress },
            executionNotBefore,
            status: 'pending',
         },
      });

      sendSuccess(res, {
         proposalId: proposal.proposalId,
         executionNotBefore: proposal.executionNotBefore.toISOString(),
      });

      await invalidateProtocolStatusCache();
   } catch (error) {
      next(error);
   }
});

// ── Oracle approved callers ───────────────────────────────────

/**
 * GET /api/v1/admin/oracle/callers
 * List all approved oracle caller addresses.
 */
adminRouter.get(
   '/oracle/callers',
   adminGuard,
   async (_req: AdminRequest, res, next) => {
      try {
         const callers = await prisma.oracleCaller.findMany({
            orderBy: { createdAt: 'desc' },
         });
         sendSuccess(
            res,
            callers.map(c => ({
               address: c.address,
               addedBy: c.addedBy,
               createdAt: c.createdAt.toISOString(),
            }))
         );
      } catch (error) {
         logger.error({ error }, 'Oracle callers list failed');
         next(error);
      }
   }
);

/**
 * POST /api/v1/admin/oracle/callers
 * Approve an external contract to call the oracle.
 */
adminRouter.post(
   '/oracle/callers',
   adminGuard,
   async (req: AdminRequest, res, next) => {
      const address = req.body?.address;
      if (!isValidStellarAddress(address)) {
         sendError(
            res,
            422,
            ErrorCode.UNPROCESSABLE_ENTITY,
            'Invalid contract address'
         );
         return;
      }

      try {
         const existing = await prisma.oracleCaller.findUnique({
            where: { address },
         });
         if (existing) {
            sendConflict(res, 'Address is already an approved caller');
            return;
         }

         // TODO: submit add_approved_caller contract call via Stellar SDK
         // On-chain failure should return 502 before reaching this point.

         const caller = await prisma.oracleCaller.create({
            data: { address, addedBy: req.adminId },
         });
         sendSuccess(
            res,
            {
               address: caller.address,
               addedBy: caller.addedBy,
               createdAt: caller.createdAt.toISOString(),
            },
            201
         );
      } catch (error) {
         logger.error({ error }, 'Oracle caller add failed');
         next(error);
      }
   }
);

/**
 * DELETE /api/v1/admin/oracle/callers/:address
 * Revoke an approved oracle caller.
 */
adminRouter.delete(
   '/oracle/callers/:address',
   adminGuard,
   async (req: AdminRequest, res, next) => {
      try {
         const address = String(req.params.address);
         const existing = await prisma.oracleCaller.findUnique({
            where: { address },
         });
         if (!existing) {
            sendNotFound(res, 'Oracle caller');
            return;
         }

         // TODO: submit remove_approved_caller contract call via Stellar SDK
         // On-chain failure should return 502 before reaching this point.

         await prisma.oracleCaller.delete({ where: { address } });
         sendSuccess(res, { address, removed: true });
      } catch (error) {
         logger.error(
            { error, address: req.params.address },
            'Oracle caller remove failed'
         );
         next(error);
      }
   }
);

// ── Timelock proposal management ──────────────────────────────

const TIMELock_DELAY_MS = 48 * 60 * 60 * 1000; // 48 hours

const proposeSchema = z.object({
   changeType: z.string().min(1),
   payload: z.record(z.unknown()),
});

/**
 * POST /api/v1/admin/timelock/propose
 *
 * Submit a propose_config_change contract call and store the proposal
 * with its executionNotBefore timestamp (now + 48h).
 */
adminRouter.get(
   '/timelock/pending',
   adminGuard,
   async (_req: AdminRequest, res, next) => {
      try {
         const actions = await prisma.timelockProposal.findMany({
            where: { status: 'pending' },
            orderBy: [{ executionNotBefore: 'asc' }, { createdAt: 'desc' }],
         });

         const serialized = actions.map(serializeTimelockAction);
         const nextAction = serialized.reduce<any>((earliest, current) => {
            if (!current.executionTimestamp) return earliest;
            if (!earliest) return current;
            return new Date(current.executionTimestamp).getTime() <
               new Date(earliest.executionTimestamp).getTime()
               ? current
               : earliest;
         }, null);

         sendSuccess(res, {
            actions: serialized,
            total: serialized.length,
            nextExecutionTimestamp: nextAction?.executionTimestamp ?? null,
            nextExecutionCountdownMs: nextAction?.countdownMs ?? null,
            nextExecutionCountdown: nextAction?.countdown ?? null,
         });
      } catch (error) {
         logger.error({ error }, 'Failed to list pending timelock actions');
         next(error);
      }
   }
);

adminRouter.get(
   '/timelock/history',
   adminGuard,
   async (_req: AdminRequest, res, next) => {
      try {
         const actions = await prisma.timelockProposal.findMany({
            where: { status: { in: ['executed', 'cancelled'] } },
            orderBy: [{ executedAt: 'desc' }, { createdAt: 'desc' }],
         });

         const history = actions.map(serializeTimelockAction);

         sendSuccess(res, {
            history,
            total: history.length,
         });
      } catch (error) {
         logger.error({ error }, 'Failed to list timelock action history');
         next(error);
      }
   }
);

adminRouter.post(
   '/timelock/propose',
   adminGuard,
   async (req: AdminRequest, res, next) => {
      try {
         const parsed = proposeSchema.safeParse(req.body);
         if (!parsed.success) {
            sendValidationError(
               res,
               'Invalid request body',
               zodIssuesToDetails(parsed.error.issues)
            );
            return;
         }

         const { changeType, payload } = parsed.data;
         const executionNotBefore = new Date(Date.now() + TIMELock_DELAY_MS);

         const proposal = await prisma.governanceProposal.create({
            data: {
               keyId: 'timelock',
               proposalId: `tl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
               title: `Timelock: ${changeType}`,
               options: ['execute', 'cancel'],
               totalVotingWeight: '0',
               results: {},
               snapshotLedger: 0,
               expiresAt: executionNotBefore,
               status: 'active',
            },
         });

         await prisma.activity.create({
            data: {
               type: 'CREATOR_REGISTERED',
               actor: req.adminId || 'unknown',
               payload: {
                  proposalId: proposal.proposalId,
                  changeType,
                  payload,
                  executionNotBefore: executionNotBefore.toISOString(),
               },
            },
         });

         sendSuccess(
            res,
            {
               proposalId: proposal.proposalId,
               changeType,
               executionNotBefore: executionNotBefore.toISOString(),
               status: 'pending',
            },
            201
         );
      } catch (error) {
         logger.error({ error }, 'Timelock propose failed');
         next(error);
      }
   }
);

adminRouter.post(
   '/timelock/:proposalId/execute',
   adminGuard,
   async (req: AdminRequest, res, next) => {
      try {
         const proposalId = String(req.params.proposalId);

         const proposal = await prisma.governanceProposal.findFirst({
            where: { keyId: 'timelock', proposalId },
         });

         if (!proposal) {
            sendNotFound(res, 'Timelock proposal');
            return;
         }

         if (proposal.status !== 'active') {
            sendError(
               res,
               400,
               ErrorCode.BAD_REQUEST,
               `Proposal is already ${proposal.status}`
            );
            return;
         }

         if (new Date() < proposal.expiresAt) {
            sendError(
               res,
               400,
               ErrorCode.BAD_REQUEST,
               'Execution window has not opened yet'
            );
            return;
         }

         await prisma.governanceProposal.update({
            where: { keyId_proposalId: { keyId: 'timelock', proposalId } },
            data: { status: 'closed', closedAt: new Date() },
         });

         await prisma.activity.create({
            data: {
               type: 'CREATOR_REGISTERED',
               actor: req.adminId || 'unknown',
               payload: {
                  proposalId,
                  action: 'executed',
               },
            },
         });

         sendSuccess(res, { proposalId, status: 'executed' });
      } catch (error) {
         logger.error(
            { error, proposalId: req.params.proposalId },
            'Timelock execute failed'
         );
         next(error);
      }
   }
);

adminRouter.post(
   '/timelock/:proposalId/cancel',
   adminGuard,
   async (req: AdminRequest, res, next) => {
      try {
         const proposalId = String(req.params.proposalId);

         const proposal = await prisma.governanceProposal.findFirst({
            where: { keyId: 'timelock', proposalId },
         });

         if (!proposal) {
            sendNotFound(res, 'Timelock proposal');
            return;
         }

         if (proposal.status !== 'active') {
            sendError(
               res,
               400,
               ErrorCode.BAD_REQUEST,
               `Proposal is already ${proposal.status}`
            );
            return;
         }

         await prisma.governanceProposal.delete({
            where: { keyId_proposalId: { keyId: 'timelock', proposalId } },
         });

         await prisma.activity.create({
            data: {
               type: 'CREATOR_REGISTERED',
               actor: req.adminId || 'unknown',
               payload: {
                  proposalId,
                  action: 'cancelled',
               },
            },
         });

         sendSuccess(res, { proposalId, status: 'cancelled' });
      } catch (error) {
         logger.error(
            { error, proposalId: req.params.proposalId },
            'Timelock cancel failed'
         );
         next(error);
      }
   }
);

adminRouter.get(
   '/timelock/proposals',
   adminGuard,
   async (_req: AdminRequest, res, next) => {
      try {
         const proposals = await prisma.governanceProposal.findMany({
            where: { keyId: 'timelock' },
            orderBy: { createdAt: 'desc' },
         });

         sendSuccess(
            res,
            proposals.map(p => ({
               proposalId: p.proposalId,
               title: p.title,
               status: p.status,
               expiresAt: p.expiresAt.toISOString(),
               closedAt: p.closedAt?.toISOString() ?? null,
               createdAt: p.createdAt.toISOString(),
            }))
         );
      } catch (error) {
         logger.error({ error }, 'Failed to list timelock proposals');
         next(error);
      }
   }
);

const supplyCapSchema = z.object({
   cap: z.number().int().positive(),
});

adminRouter.post(
   '/creator/:keyId/supply-cap',
   requireKeyCreator('keyId'),
   async (req: AuthenticatedRequest, res, next) => {
      try {
         const keyId = String(req.params.keyId);

         const parsed = supplyCapSchema.safeParse(req.body);
         if (!parsed.success) {
            sendValidationError(
               res,
               'Invalid request body',
               zodIssuesToDetails(parsed.error.issues)
            );
            return;
         }

         const { cap } = parsed.data;

         const creator = await prisma.creatorProfile.findUnique({
            where: { id: keyId },
            select: { id: true, supplyCap: true, circulatingSupply: true },
         });

         if (!creator) {
            sendNotFound(res, 'Key');
            return;
         }

         const circulating = Number(creator.circulatingSupply);
         if (cap < circulating) {
            sendConflict(
               res,
               `Cap cannot be lower than current circulating supply (${circulating})`
            );
            return;
         }

         const updated = await prisma.creatorProfile.update({
            where: { id: keyId },
            data: { supplyCap: cap },
         });

         await prisma.activity.create({
            data: {
               type: 'SUPPLY_CAP_SET',
               actor: req.user!.wallet,
               creatorId: keyId,
               payload: {
                  keyId,
                  previousCap: creator.supplyCap,
                  newCap: cap,
                  circulatingSupply: circulating,
                  remainingMintable: cap - circulating,
               },
            },
         });

         sendSuccess(res, {
            supplyCap: updated.supplyCap,
            remainingMintable: cap - circulating,
         });
      } catch (error) {
         logger.error(
            { error, keyId: req.params.keyId },
            'Supply cap update failed'
         );
         next(error);
      }
   }
);

adminRouter.post(
   '/keys/:keyId/pause/propose',
   adminGuard,
   async (req: AdminRequest, res, next) => {
      try {
         const keyId = String(req.params.keyId);

         const creator = await prisma.creatorProfile.findFirst({
            where: { OR: [{ id: keyId }, { handle: keyId }] },
         });

         if (!creator) {
            sendNotFound(res, 'Key');
            return;
         }

         const proposalId = `pause-${creator.id}-${Date.now()}`;
         const proposerWallet = req.adminId || 'unknown';

         const proposal = await prisma.pauseProposal.create({
            data: {
               proposalId,
               keyId: creator.id,
               proposerWallet,
               status: 'pending',
            },
         });

         await prisma.activity.create({
            data: {
               type: 'TRADING_PAUSE_PROPOSED',
               actor: proposerWallet,
               creatorId: creator.id,
               payload: {
                  proposalId,
                  keyId: creator.id,
                  notification: 'pause_proposal_created',
               },
            },
         });

         sendSuccess(
            res,
            {
               proposalId: proposal.proposalId,
               keyId: creator.id,
               proposerWallet,
               status: 'pending',
               notification: 'pause_proposal_created',
            },
            201
         );
      } catch (error) {
         logger.error(
            { error, keyId: req.params.keyId },
            'Pause propose failed'
         );
         next(error);
      }
   }
);

adminRouter.post(
   '/keys/:keyId/pause/approve',
   adminGuard,
   async (req: AdminRequest, res, next) => {
      try {
         const keyId = String(req.params.keyId);
         const approverWallet = req.adminId || 'unknown';

         const creator = await prisma.creatorProfile.findFirst({
            where: { OR: [{ id: keyId }, { handle: keyId }] },
         });

         if (!creator) {
            sendNotFound(res, 'Key');
            return;
         }

         const proposal = await prisma.pauseProposal.findFirst({
            where: { keyId: creator.id, status: 'pending' },
            orderBy: { createdAt: 'desc' },
         });

         if (!proposal) {
            sendNotFound(res, 'Pending pause proposal');
            return;
         }

         if (
            proposal.proposerWallet.toLowerCase() ===
            approverWallet.toLowerCase()
         ) {
            sendForbidden(
               res,
               'Cannot approve your own pause proposal. Multi-sig requires two distinct admins.'
            );
            return;
         }

         await prisma.pauseProposal.update({
            where: { id: proposal.id },
            data: {
               status: 'executed',
               approverWallet,
               executedAt: new Date(),
            },
         });

         await prisma.creatorProfile.update({
            where: { id: creator.id },
            data: { tradingPaused: true },
         });

         await prisma.activity.create({
            data: {
               type: 'TRADING_PAUSE_APPROVED',
               actor: approverWallet,
               creatorId: creator.id,
               payload: {
                  proposalId: proposal.proposalId,
                  keyId: creator.id,
                  notification: 'trading_paused',
               },
            },
         });

         sendSuccess(res, {
            proposalId: proposal.proposalId,
            keyId: creator.id,
            status: 'executed',
            isTradingPaused: true,
            notification: 'trading_paused',
         });
      } catch (error) {
         logger.error(
            { error, keyId: req.params.keyId },
            'Pause approve failed'
         );
         next(error);
      }
   }
);

const lockupDurationSchema = z.object({
   durationSeconds: z
      .number({ required_error: 'durationSeconds is required' })
      .int('durationSeconds must be an integer')
      .min(3600, 'durationSeconds must be between 3600 and 604800')
      .max(604800, 'durationSeconds must be between 3600 and 604800'),
});

adminRouter.post(
   '/protocol/lockup',
   adminGuard,
   async (req: AdminRequest, res, next) => {
      try {
         const parsed = lockupDurationSchema.safeParse(req.body);
         if (!parsed.success) {
            sendError(
               res,
               422,
               ErrorCode.VALIDATION_ERROR,
               'Invalid request body',
               zodIssuesToDetails(parsed.error.issues)
            );
            return;
         }

         const { durationSeconds } = parsed.data;
         const executionNotBefore = new Date(Date.now() + TIMELock_DELAY_MS);
         const proposalId = `tl-lockup-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

         logger.info(
            {
               operation: 'propose_config_change',
               changeType: 'update_lockup',
               durationSeconds,
               executionNotBefore,
            },
            'Submitting propose_config_change contract call'
         );

         const proposal = await prisma.timelockProposal.create({
            data: {
               proposalId,
               changeType: 'update_lockup',
               payload: { durationSeconds },
               executionNotBefore,
               status: 'pending',
            },
         });

         await prisma.governanceProposal.create({
            data: {
               keyId: 'timelock',
               proposalId,
               title: 'Timelock: update_lockup',
               options: ['execute', 'cancel'],
               totalVotingWeight: '0',
               results: {},
               snapshotLedger: 0,
               expiresAt: executionNotBefore,
               status: 'active',
            },
         });

         await createAuditEntry({
            actorWallet: req.adminId || 'unknown',
            actionType: 'TIMELOCK_LOCKUP_PROPOSED',
            targetId: proposalId,
            payload: {
               proposalId,
               changeType: 'update_lockup',
               durationSeconds,
               executionNotBefore: executionNotBefore.toISOString(),
            },
         });

         await prisma.activity.create({
            data: {
               type: 'CREATOR_REGISTERED',
               actor: req.adminId || 'unknown',
               payload: {
                  proposalId,
                  changeType: 'update_lockup',
                  durationSeconds,
                  executionNotBefore: executionNotBefore.toISOString(),
               },
            },
         });

         sendSuccess(
            res,
            {
               proposalId: proposal.proposalId,
               executionNotBefore: proposal.executionNotBefore.toISOString(),
               changeType: 'update_lockup',
               durationSeconds,
               status: 'pending',
            },
            201
         );
      } catch (error) {
         logger.error({ error }, 'Protocol lockup proposal failed');
         next(error);
      }
   }
);

const circuitBreakerSchema = z.object({
   thresholdBps: z
      .number({ required_error: 'thresholdBps is required' })
      .int('thresholdBps must be an integer')
      .min(100, 'thresholdBps must be between 100 and 5000')
      .max(5000, 'thresholdBps must be between 100 and 5000'),
});

adminRouter.post(
   '/keys/:keyId/circuit-breaker',
   adminGuard,
   async (req: AdminRequest, res, next) => {
      try {
         const keyId = String(req.params.keyId);

         const parsed = circuitBreakerSchema.safeParse(req.body);
         if (!parsed.success) {
            sendError(
               res,
               422,
               ErrorCode.VALIDATION_ERROR,
               'Invalid request body',
               zodIssuesToDetails(parsed.error.issues)
            );
            return;
         }

         const { thresholdBps } = parsed.data;

         const creator = await prisma.creatorProfile.findFirst({
            where: { OR: [{ id: keyId }, { handle: keyId }] },
         });

         if (!creator) {
            sendNotFound(res, 'Key');
            return;
         }

         const oldThresholdBps = creator.circuitBreakerThreshold ?? 3000;

         logger.info(
            {
               operation: 'set_circuit_breaker_threshold',
               keyId: creator.id,
               oldThresholdBps,
               newThresholdBps: thresholdBps,
            },
            'Submitting set_circuit_breaker_threshold contract call'
         );

         const updated = await prisma.creatorProfile.update({
            where: { id: creator.id },
            data: { circuitBreakerThreshold: thresholdBps },
         });

         await createAuditEntry({
            actorWallet: req.adminId || 'unknown',
            actionType: 'CIRCUIT_BREAKER_THRESHOLD_UPDATED',
            targetId: creator.id,
            payload: {
               keyId: creator.id,
               oldThresholdBps,
               newThresholdBps: thresholdBps,
            },
         });

         await prisma.activity.create({
            data: {
               type: 'CIRCUIT_BREAKER_THRESHOLD_UPDATED',
               actor: req.adminId || 'unknown',
               creatorId: creator.id,
               payload: {
                  keyId: creator.id,
                  previousThresholdBps: oldThresholdBps,
                  newThresholdBps: thresholdBps,
               },
            },
         });

         sendSuccess(res, {
            keyId: creator.id,
            circuitBreakerThreshold: updated.circuitBreakerThreshold,
            previousThresholdBps: oldThresholdBps,
         });
      } catch (error) {
         logger.error(
            { error, keyId: req.params.keyId },
            'Circuit breaker update failed'
         );
         next(error);
      }
   }
);

export default adminRouter;
