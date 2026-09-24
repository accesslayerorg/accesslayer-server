import { Router } from 'express';
import { httpListCreators, httpGetCreatorStats } from '../creators/creators.controllers';
import { cacheControl } from '../../middlewares/cache-control.middleware';
import { CREATOR_PUBLIC_ROUTE_CACHE_PRESETS } from '../../constants/creator-public-cache.constants';
import { CREATOR_PUBLIC_ROUTE_NAMES } from '../../constants/creator-public-routes.constants';
import { createCreatorReadMetricsMiddleware } from '../../utils/creator-read-metrics.utils';
import { normalizeTrailingSlash } from '../../middlewares/trailing-slash-normalizer.middleware';
import { requireKeyCreator, AuthenticatedRequest } from '../../middlewares/jwt-auth.middleware';
import { sendError, sendSuccess } from '../../utils/api-response.utils';
import { ErrorCode } from '../../constants/error.constants';
import { prisma } from '../../utils/prisma.utils';
import { curveGateway } from './creator-curve.service';

const creatorsRouter = Router();

// Normalize trailing slashes for all creator routes so that, e.g.,
// GET /api/v1/creators/ reaches the same handler as GET /api/v1/creators.
// Scoped to this router to avoid side-effects on other route groups.
creatorsRouter.use(normalizeTrailingSlash);

/**
 * GET /api/v1/creators
 *
 * List all creators with pagination and filtering.
 * Public endpoint with 5-minute cache.
 */
creatorsRouter.get(
   '/',
   createCreatorReadMetricsMiddleware('list'),
   cacheControl(CREATOR_PUBLIC_ROUTE_CACHE_PRESETS[CREATOR_PUBLIC_ROUTE_NAMES.LIST]),
   httpListCreators
);
// 405 handler for /
creatorsRouter.all('/', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

/**
 * GET /api/v1/creators/:id/stats
 *
 * Get public stats for a specific creator.
 * Public endpoint with 5-minute cache.
 */
creatorsRouter.get(
   '/:id/stats',
   createCreatorReadMetricsMiddleware('detail'),
   cacheControl(CREATOR_PUBLIC_ROUTE_CACHE_PRESETS[CREATOR_PUBLIC_ROUTE_NAMES.GET_STATS]),
   httpGetCreatorStats
);
// 405 handler for /:id/stats
creatorsRouter.all('/:id/stats', (_req, res) => {
   res.set('Allow', 'GET').sendStatus(405);
});

/**
 * POST /api/v1/creator/:keyId/holder-cap
 * Update holder cap endpoint for creators to change max keys a single wallet can hold (#841).
 */
creatorsRouter.post(
   '/:keyId/holder-cap',
   requireKeyCreator('keyId'),
   async (req: AuthenticatedRequest, res, next) => {
      const { capBps } = req.body || {};
      if (
         capBps === undefined ||
         capBps === null ||
         typeof capBps !== 'number' ||
         capBps < 100 ||
         capBps > 2500
      ) {
         sendError(
            res,
            422,
            ErrorCode.UNPROCESSABLE_ENTITY,
            'capBps must be between 100 and 2500'
         );
         return;
      }

      const keyId = Array.isArray(req.params.keyId)
         ? req.params.keyId[0]
         : req.params.keyId;
      try {
         const creatorProfile = await prisma.creatorProfile.findFirst({
            where: { OR: [{ id: keyId }, { handle: keyId }] },
         });
         if (!creatorProfile) {
            sendError(res, 404, ErrorCode.NOT_FOUND, 'Key not found');
            return;
         }

         const updated = await prisma.creatorProfile.update({
            where: { id: creatorProfile.id },
            data: { holderCapBps: capBps },
         });

         sendSuccess(res, {
            holderCapBps: updated.holderCapBps,
            percentage: `${updated.holderCapBps / 100}%`,
         });
      } catch (error) {
         next(error);
      }
   }
);

/**
 * POST /api/v1/creator/:keyId/curve
 * Configure graduated bonding curve milestones for a creator key (#869).
 */
creatorsRouter.post(
   '/:keyId/curve',
   requireKeyCreator('keyId'),
   async (req: AuthenticatedRequest, res, next) => {
      const keyId = Array.isArray(req.params.keyId)
         ? req.params.keyId[0]
         : req.params.keyId;

      const { milestones } = req.body || {};

      if (!Array.isArray(milestones) || milestones.length === 0) {
         sendError(
            res,
            422,
            ErrorCode.UNPROCESSABLE_ENTITY,
            'milestones must be a non-empty array'
         );
         return;
      }

      if (milestones.length > 5) {
         sendError(
            res,
            422,
            ErrorCode.UNPROCESSABLE_ENTITY,
            'Maximum of 5 milestones allowed'
         );
         return;
      }

      for (let i = 0; i < milestones.length; i++) {
         const m = milestones[i];
         if (
            !m ||
            typeof m.supplyThreshold !== 'number' ||
            typeof m.exponent !== 'number' ||
            isNaN(m.supplyThreshold) ||
            isNaN(m.exponent)
         ) {
            sendError(
               res,
               422,
               ErrorCode.UNPROCESSABLE_ENTITY,
               'Each milestone must have supplyThreshold and exponent'
            );
            return;
         }

         if (m.supplyThreshold <= 0) {
            sendError(
               res,
               422,
               ErrorCode.UNPROCESSABLE_ENTITY,
               'supplyThreshold must be positive'
            );
            return;
         }

         if (
            m.exponent < 1 ||
            m.exponent > 5 ||
            !Number.isInteger(m.exponent)
         ) {
            sendError(
               res,
               422,
               ErrorCode.UNPROCESSABLE_ENTITY,
               'exponent must be an integer between 1 and 5'
            );
            return;
         }

         if (i > 0 && m.supplyThreshold <= milestones[i - 1].supplyThreshold) {
            sendError(
               res,
               422,
               ErrorCode.UNPROCESSABLE_ENTITY,
               'supplyThreshold values must be in strictly ascending order'
            );
            return;
         }
      }

      try {
         const creatorProfile = await prisma.creatorProfile.findFirst({
            where: { OR: [{ id: keyId }, { handle: keyId }] },
         });
         if (!creatorProfile) {
            sendError(res, 404, ErrorCode.NOT_FOUND, 'Key not found');
            return;
         }

         // Submit configure_graduated_curve contract call
         await curveGateway.configureGraduatedCurve({
            creatorId: creatorProfile.id,
            milestones,
         });

         const updated = await prisma.creatorProfile.update({
            where: { id: creatorProfile.id },
            data: { curveMilestones: milestones },
         });

         await prisma.activity.create({
            data: {
               type: 'GRADUATED_CURVE_CONFIGURED',
               actor: req.user!.wallet,
               creatorId: creatorProfile.id,
               payload: {
                  keyId: creatorProfile.id,
                  milestones,
               },
            },
         });

         sendSuccess(res, {
            keyId: creatorProfile.id,
            milestones: (updated.curveMilestones as any) ?? milestones,
            baseExponent: updated.baseExponent ?? 1,
         });
      } catch (error) {
         next(error);
      }
   }
);

export default creatorsRouter;