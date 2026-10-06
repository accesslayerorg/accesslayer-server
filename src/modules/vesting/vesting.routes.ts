// src/modules/vesting/vesting.routes.ts
import { Router } from 'express';
import {
  sendError,
  sendNotFound,
  sendSuccess,
} from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import {
  requireJwtAuth,
  requireKeyCreator,
  requireWalletParamMatch,
  AuthenticatedRequest,
} from '../../middlewares/jwt-auth.middleware';
import {
  getKeyVestingHistory,
  getKeyVestingSummary,
  getVestingSchedule,
  invalidateKeyVestingCache,
  VestingNotFoundError,
} from './vesting.service';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';

const vestingRouter = Router();

const VESTING_CACHE_TTL_SECONDS = 60;

/**
 * GET /api/v1/keys/:keyId/vesting
 * Creator-only. Returns vesting schedule metadata for every beneficiary on a key.
 */
vestingRouter.get(
  '/keys/:keyId/vesting',
  requireKeyCreator('keyId'),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const keyId = Array.isArray(req.params.keyId)
        ? req.params.keyId[0]
        : req.params.keyId;
      const ledger = await prisma.indexedLedger.findFirst({
        orderBy: { updatedAt: 'desc' },
        select: { ledger: true },
      });
      const currentLedger = ledger?.ledger ?? 0;
      const cacheKey = `key:vesting:${keyId}`;
      const cached = await cacheGetJson<any>(cacheKey);
      if (cached !== null) {
        return sendSuccess(res, cached);
      }

      const result = await getKeyVestingSummary(keyId, currentLedger);
      await cacheSetJson(cacheKey, result, VESTING_CACHE_TTL_SECONDS);
      sendSuccess(res, result);
    } catch (error) {
      if (error instanceof Error && error.name === 'KeyVestingNotFoundError') {
        sendNotFound(res, 'Vesting schedule');
        return;
      }
      next(error);
    }
  }
);

vestingRouter.get(
  '/keys/:keyId/vesting/history',
  requireKeyCreator('keyId'),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const keyId = Array.isArray(req.params.keyId)
        ? req.params.keyId[0]
        : req.params.keyId;
      const limit = Number(req.query.limit ?? '20');
      const cacheKey = `key:vesting:${keyId}:history`;
      const cached = await cacheGetJson<any>(cacheKey);
      if (cached !== null) {
        return sendSuccess(res, cached);
      }

      const result = await getKeyVestingHistory(keyId, Number.isFinite(limit) ? limit : 20);
      await cacheSetJson(cacheKey, result, VESTING_CACHE_TTL_SECONDS);
      sendSuccess(res, result);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/v1/vesting/:keyId/:wallet
 *
 * Returns the vesting schedule and claimable amount for a beneficiary.
 * Requires a JWT whose wallet matches the :wallet path param.
 */
vestingRouter.get(
  '/:keyId/:wallet',
  requireWalletParamMatch('wallet'),
  async (req, res, next) => {
    try {
      const keyId = Array.isArray(req.params.keyId) ? req.params.keyId[0] : req.params.keyId;
      const wallet = Array.isArray(req.params.wallet) ? req.params.wallet[0] : req.params.wallet;
      const ledger = await prisma.indexedLedger.findFirst({
        orderBy: { updatedAt: 'desc' },
        select: { ledger: true },
      });
      const currentLedger = ledger?.ledger ?? 0;
      sendSuccess(
        res,
        await getVestingSchedule(keyId, wallet, currentLedger)
      );
    } catch (error) {
      if (error instanceof VestingNotFoundError) {
        sendNotFound(res, 'Vesting schedule');
        return;
      }
      next(error);
    }
  }
);

vestingRouter.all('/:keyId/:wallet', (_req, res) => {
  res.set('Allow', 'GET').sendStatus(405);
});

/**
 * POST /api/v1/vesting/:keyId/claim
 *
 * Submit claim_vested contract call and update claimedAmount on the vesting
 * schedule record. Requires a JWT whose wallet matches the beneficiary.
 */
vestingRouter.post(
  '/:keyId/claim',
  requireJwtAuth,
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const keyId = String(req.params.keyId);
      const wallet = req.user!.wallet;

      const schedule = await prisma.vestingSchedule.findUnique({
        where: { keyId_wallet: { keyId, wallet } },
      });

      if (!schedule) {
        sendNotFound(res, 'Vesting schedule');
        return;
      }

      if (schedule.wallet.toLowerCase() !== wallet.toLowerCase()) {
        sendError(res, 403, ErrorCode.FORBIDDEN, 'Only the beneficiary can claim vested keys');
        return;
      }

      const ledger = await prisma.indexedLedger.findFirst({
        orderBy: { updatedAt: 'desc' },
        select: { ledger: true },
      });
      const currentLedger = ledger?.ledger ?? 0;

      const total = BigInt(schedule.totalKeys.toString());
      const claimed = BigInt(schedule.claimedKeys.toString());
      const start = schedule.startLedger;
      const end = schedule.endLedger;

      let vested = 0n;
      if (currentLedger >= end) {
        vested = total;
      } else if (currentLedger > start) {
        const elapsed = BigInt(currentLedger - start);
        const duration = BigInt(end - start);
        vested = (total * elapsed) / duration;
      }

      const claimable = vested > claimed ? vested - claimed : 0n;

      if (claimable <= 0n) {
        sendError(res, 400, ErrorCode.BAD_REQUEST, 'NothingToClaim');
        return;
      }

      const newClaimed = claimed + claimable;
      await prisma.vestingSchedule.update({
        where: { keyId_wallet: { keyId, wallet } },
        data: { claimedKeys: newClaimed.toString() },
      });

      const updatedClaimable = vested > newClaimed ? vested - newClaimed : 0n;
      const txHash = `optimistic-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      await prisma.vestingClaimHistory.create({
        data: {
          vestingId: schedule.id,
          keyId: schedule.keyId,
          wallet: schedule.wallet,
          claimedAmount: claimable.toString(),
          txHash,
          ledger: currentLedger,
        },
      });
      await invalidateKeyVestingCache(keyId);

      await prisma.activity.create({
        data: {
          type: 'KEYS_CLAIMED',
          actor: wallet,
          creatorId: keyId,
          payload: {
            keyId,
            claimed: claimable.toString(),
            claimableAfter: updatedClaimable.toString(),
          },
        },
      });

      sendSuccess(res, {
        claimed: claimable.toString(),
        claimableAmount: updatedClaimable.toString(),
      });
    } catch (error) {
      logger.error({ error, keyId: req.params.keyId }, 'Vesting claim failed');
      next(error);
    }
  }
);

vestingRouter.all('/:keyId/claim', (_req, res) => {
  res.set('Allow', 'POST').sendStatus(405);
});

export default vestingRouter;
