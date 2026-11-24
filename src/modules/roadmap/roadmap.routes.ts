// src/modules/roadmap/roadmap.routes.ts
// Creator roadmap endpoints and holder-gated milestone reactions (#1310).

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import {
   requireJwtAuth,
   requireKeyCreator,
   AuthenticatedRequest,
} from '../../middlewares/jwt-auth.middleware';
import {
   sendSuccess,
   sendError,
   sendValidationError,
   zodIssuesToDetails,
   ErrorCode,
   ErrorCodeType,
} from '../../utils/api-response.utils';
import { logger } from '../../utils/logger.utils';
import {
   getKeyRoadmap,
   createRoadmapMilestone,
   updateRoadmapMilestone,
   reorderRoadmapMilestones,
   addMilestoneReaction,
   RoadmapServiceError,
} from './roadmap.service';

const statusSchema = z.enum([
   'PLANNED',
   'IN_PROGRESS',
   'DELAYED',
   'COMPLETED',
   'CANCELLED',
]);

const createMilestoneSchema = z.object({
   title: z.string().trim().min(1).max(200),
   description: z.string().trim().max(2000).optional(),
   status: statusSchema.optional(),
   position: z.number().int().nonnegative().optional(),
   targetDate: z.string().datetime().optional(),
   revisedDate: z.string().datetime().optional(),
   delayReason: z.string().trim().min(1).max(500).optional(),
});

const updateMilestoneSchema = z.object({
   title: z.string().trim().min(1).max(200).optional(),
   description: z.string().trim().max(2000).optional(),
   status: statusSchema.optional(),
   targetDate: z.string().datetime().nullable().optional(),
   revisedDate: z.string().datetime().nullable().optional(),
   delayReason: z.string().trim().min(1).max(500).nullable().optional(),
});

const reorderSchema = z.object({
   orderedIds: z.array(z.string().min(1)).min(1),
});

const reactionSchema = z.object({
   reaction: z.string().trim().min(1).max(32),
});

function handleRoadmapError(
   res: Response,
   error: unknown,
   context: string
): void {
   if (error instanceof RoadmapServiceError) {
      sendError(res, error.statusCode, error.code as ErrorCodeType, error.message);
      return;
   }
   logger.error({ error }, context);
   sendError(res, 500, ErrorCode.INTERNAL_ERROR, context);
}

export const keyRoadmapRouter = Router();

keyRoadmapRouter.get('/:keyId/roadmap', async (req: Request, res: Response) => {
   try {
      const milestones = await getKeyRoadmap(String(req.params.keyId));
      sendSuccess(res, { milestones });
   } catch (error) {
      handleRoadmapError(res, error, 'Failed to fetch creator roadmap');
   }
});

keyRoadmapRouter.post(
   '/:keyId/roadmap',
   requireKeyCreator('keyId'),
   async (req: AuthenticatedRequest, res: Response) => {
      const parsed = createMilestoneSchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid milestone payload',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      try {
         const milestone = await createRoadmapMilestone({
            keyId: String(req.params.keyId),
            ...parsed.data,
         });
         sendSuccess(res, { milestone }, 201);
      } catch (error) {
         handleRoadmapError(res, error, 'Failed to create roadmap milestone');
      }
   }
);

keyRoadmapRouter.put(
   '/:keyId/roadmap/order',
   requireKeyCreator('keyId'),
   async (req: AuthenticatedRequest, res: Response) => {
      const parsed = reorderSchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid milestone order payload',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      try {
         const milestones = await reorderRoadmapMilestones({
            keyId: String(req.params.keyId),
            orderedIds: parsed.data.orderedIds,
         });
         sendSuccess(res, { milestones });
      } catch (error) {
         handleRoadmapError(res, error, 'Failed to reorder roadmap milestones');
      }
   }
);

keyRoadmapRouter.patch(
   '/:keyId/roadmap/:milestoneId',
   requireKeyCreator('keyId'),
   async (req: AuthenticatedRequest, res: Response) => {
      const parsed = updateMilestoneSchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid milestone update payload',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      try {
         const milestone = await updateRoadmapMilestone({
            keyId: String(req.params.keyId),
            milestoneId: String(req.params.milestoneId),
            ...parsed.data,
         });
         sendSuccess(res, { milestone });
      } catch (error) {
         handleRoadmapError(res, error, 'Failed to update roadmap milestone');
      }
   }
);

export const milestoneReactionsRouter = Router();

milestoneReactionsRouter.post(
   '/:id/reactions',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response) => {
      const parsed = reactionSchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid milestone reaction payload',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      try {
         const reaction = await addMilestoneReaction({
            milestoneId: String(req.params.id),
            walletAddress: req.user!.wallet,
            reaction: parsed.data.reaction,
         });
         sendSuccess(res, { reaction }, 201);
      } catch (error) {
         handleRoadmapError(res, error, 'Failed to add milestone reaction');
      }
   }
);
