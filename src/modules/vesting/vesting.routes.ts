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
   requireWalletParamMatch,
   AuthenticatedRequest,
} from '../../middlewares/jwt-auth.middleware';
import { getVestingSchedule, VestingNotFoundError } from './vesting.service';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';

const vestingRouter = Router();

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
         const keyId = Array.isArray(req.params.keyId)
            ? req.params.keyId[0]
            : req.params.keyId;
         const wallet = Array.isArray(req.params.wallet)
            ? req.params.wallet[0]
            : req.params.wallet;
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

         // Check that the JWT wallet matches the beneficiary
         if (schedule.wallet.toLowerCase() !== wallet.toLowerCase()) {
            sendError(
               res,
               403,
               ErrorCode.FORBIDDEN,
               'Only the beneficiary can claim vested keys'
            );
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

         // TODO: submit claim_vested contract call via Stellar SDK
         // For now, we update the database optimistically.
         // On-chain failure should return 502 before reaching this point.

         const newClaimed = claimed + claimable;
         await prisma.vestingSchedule.update({
            where: { keyId_wallet: { keyId, wallet } },
            data: { claimedKeys: newClaimed.toString() },
         });

         const updatedClaimable =
            vested > newClaimed ? vested - newClaimed : 0n;

         // Write activity log
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
         logger.error(
            { error, keyId: req.params.keyId },
            'Vesting claim failed'
         );
         next(error);
      }
   }
);

vestingRouter.all('/:keyId/claim', (_req, res) => {
   res.set('Allow', 'POST').sendStatus(405);
});

export default vestingRouter;
