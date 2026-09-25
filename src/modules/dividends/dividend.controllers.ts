import { AsyncController } from '../../types/auth.types';
import {
   sendSuccess,
   sendValidationError,
   sendNotFound,
} from '../../utils/api-response.utils';
import { Response } from 'express';
import {
   GetDividendDistributionsQuery,
   GetDividendDistributionsQuerySchema,
   GetDividendClaimsQuery,
   GetDividendClaimsQuerySchema,
} from './dividend.schemas';
import {
   getDividendDistributions,
   getDividendClaims,
   getDividendDistributionById,
   creatorExists,
} from './dividend.service';

/**
 * GET /keys/:keyId/dividends
 * Returns all past dividend distributions for a creator key with pagination.
 */
export const httpGetDividendDistributions: AsyncController = async (
   req,
   res,
   next
) => {
   try {
      const { keyId } = req.params as { keyId: string };

      if (!keyId) {
         return sendValidationError(res, 'Missing required parameters', [
            { field: 'keyId', message: 'Key ID is required' },
         ]);
      }

      // Verify creator exists
      const creatorId = keyId;
      const exists = await creatorExists(creatorId);
      if (!exists) {
         return sendNotFound(res, 'Creator');
      }

      // Parse and validate query parameters
      const parsed = GetDividendDistributionsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
         return sendValidationError(res, 'Invalid query parameters', [
            {
               field: 'query',
               message: 'Invalid pagination parameters',
            },
         ]);
      }

      const query = parsed.data as GetDividendDistributionsQuery;

      // Fetch distributions
      const result = await getDividendDistributions({
         creatorId,
         limit: query.limit,
         cursor: query.cursor,
      });

      // Format response
      const entries = result.distributions.map(dist => ({
         distributionId: dist.id,
         totalAmount: Number(dist.totalAmount),
         holderCount: dist.holderCount,
         perKeyAmount: Number(dist.perKeyAmount),
         distributedAt: dist.distributedAt.toISOString(),
      }));

      return sendSuccess(res, {
         entries,
         pagination: {
            limit: query.limit,
            hasMore: result.hasMore,
            nextCursor: result.nextCursor,
         },
      });
   } catch (error) {
      next(error);
   }
};

/**
 * GET /keys/:keyId/dividends/:distributionId/holders
 * Returns the per-holder payout breakdown for a specific distribution.
 */
export const httpGetDividendHolders: AsyncController = async (
   req,
   res,
   next
) => {
   try {
      const { keyId, distributionId } = req.params as {
         keyId: string;
         distributionId: string;
      };

      if (!keyId || !distributionId) {
         return sendValidationError(res, 'Missing required parameters', [
            ...(keyId
               ? []
               : [{ field: 'keyId', message: 'Key ID is required' }]),
            ...(distributionId
               ? []
               : [
                    {
                       field: 'distributionId',
                       message: 'Distribution ID is required',
                    },
                 ]),
         ]);
      }

      // Verify creator exists
      const creatorId = keyId;
      const exists = await creatorExists(creatorId);
      if (!exists) {
         return sendNotFound(res, 'Creator');
      }

      // Verify distribution exists and belongs to this creator
      const distribution = await getDividendDistributionById(distributionId);
      if (!distribution) {
         return sendNotFound(res, 'Distribution');
      }

      if (distribution.creatorId !== creatorId) {
         return sendNotFound(res, 'Distribution');
      }

      // Parse and validate query parameters
      const parsed = GetDividendClaimsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
         return sendValidationError(res, 'Invalid query parameters', [
            {
               field: 'query',
               message: 'Invalid pagination parameters',
            },
         ]);
      }

      const query = parsed.data as GetDividendClaimsQuery;

      // Fetch claims
      const result = await getDividendClaims({
         distributionId,
         limit: query.limit,
         cursor: query.cursor,
      });

      // Format response
      const entries = result.claims.map(claim => ({
         recipientWallet: claim.recipientAddress,
         amountXlm: Number(claim.amountXlm),
         claimedAt: claim.claimedAt ? claim.claimedAt.toISOString() : null,
      }));

      return sendSuccess(res, {
         entries,
         pagination: {
            limit: query.limit,
            hasMore: result.hasMore,
            nextCursor: result.nextCursor,
         },
      });
   } catch (error) {
      next(error);
   }
};

import {
   createDividendDistribution,
   InsufficientBalanceError,
} from './dividend.service';
import { AuthenticatedRequest } from '../../middlewares/jwt-auth.middleware';

/**
 * POST /creator/:keyId/dividends
 * Creates and submits a dividend distribution for a creator key.
 */
export const httpDistributeDividend: AsyncController = async (
   req: AuthenticatedRequest,
   res: Response,
   next
) => {
   try {
      const { keyId } = req.params as { keyId: string };
      const totalAmountRaw = req.body?.totalAmount;

      if (totalAmountRaw === undefined || totalAmountRaw === null) {
         return res.status(422).json({
            error: {
               code: 'VALIDATION_ERROR',
               message: 'totalAmount is required',
               details: [{ field: 'totalAmount', message: 'Required' }],
            },
         });
      }

      const totalAmountNum = Number(totalAmountRaw);
      if (isNaN(totalAmountNum) || totalAmountNum <= 0) {
         return res.status(422).json({
            error: {
               code: 'VALIDATION_ERROR',
               message: 'totalAmount must be a positive integer',
               details: [
                  { field: 'totalAmount', message: 'Must be greater than 0' },
               ],
            },
         });
      }

      if (!req.user || !req.user.wallet) {
         return res.status(403).json({
            error: {
               code: 'FORBIDDEN',
               message: 'Only the key creator can distribute dividends',
            },
         });
      }

      const callerWallet = req.user.wallet;

      // Verify creator ownership
      const creator = await prisma.creatorProfile.findFirst({
         where: { OR: [{ id: keyId }, { handle: keyId }] },
         include: { user: { include: { stellarWallet: true } } },
      });

      if (!creator) {
         return sendNotFound(res, 'Creator');
      }

      const creatorWalletAddress = creator.user?.stellarWallet?.address;
      if (
         !creatorWalletAddress ||
         creatorWalletAddress.toLowerCase() !== callerWallet.toLowerCase()
      ) {
         return res.status(403).json({
            error: {
               code: 'FORBIDDEN',
               message: 'Only the key creator can distribute dividends',
            },
         });
      }

      try {
         const result = await createDividendDistribution({
            creatorId: creator.id,
            totalAmount: totalAmountNum,
            creatorWallet: callerWallet,
         });

         return sendSuccess(res, result, 201);
      } catch (err: any) {
         if (
            err instanceof InsufficientBalanceError ||
            err.name === 'InsufficientBalanceError'
         ) {
            return res.status(400).json({
               error: {
                  code: 'BAD_REQUEST',
                  message: err.message || 'Insufficient wallet balance',
               },
            });
         }
         throw err;
      }
   } catch (error) {
      next(error);
   }
};
