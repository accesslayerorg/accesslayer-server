import { Router, Request, Response, NextFunction } from 'express';
import { adminGuard, AdminRequest } from '../../middlewares/admin-guard.middleware';
import {
   AuthenticatedRequest,
   requireJwtAuth,
} from '../../middlewares/jwt-auth.middleware';
import {
   sendConflict,
   sendNotFound,
   sendSuccess,
   sendValidationError,
   zodIssuesToDetails,
} from '../../utils/api-response.utils';
import {
   acceptDisclosureSchema,
   publishDisclosureSchema,
} from './disclosures.schemas';
import {
   acceptDisclosure,
   DisclosureVersionExistsError,
   getCurrentDisclosure,
   NoActiveDisclosureError,
   OutdatedDisclosureVersionError,
   publishDisclosureVersion,
} from './disclosures.service';

export const disclosuresRouter = Router();
export const disclosuresAdminRouter = Router();

/**
 * GET /v1/disclosures/current
 * Returns the active risk disclosure version, text hash, and content URL.
 */
disclosuresRouter.get(
   '/current',
   async (_req: Request, res: Response, next: NextFunction) => {
      try {
         const current = await getCurrentDisclosure();
         sendSuccess(res, current, 200);
      } catch (error) {
         if (error instanceof NoActiveDisclosureError) {
            sendNotFound(res, 'Active disclosure version');
            return;
         }
         next(error);
      }
   }
);

/**
 * POST /v1/disclosures/accept
 * Records wallet acceptance of the current active disclosure version.
 * Returns 409 if the submitted version is outdated.
 */
disclosuresRouter.post(
   '/accept',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      const parsed = acceptDisclosureSchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid disclosure acceptance payload',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      const wallet = req.user!.wallet;
      const ip = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
      const userAgent = req.get('user-agent') ?? 'unknown';

      try {
         const acceptance = await acceptDisclosure(
            wallet,
            parsed.data.versionId,
            ip,
            userAgent
         );
         sendSuccess(res, acceptance, 200);
      } catch (error) {
         if (error instanceof NoActiveDisclosureError) {
            sendNotFound(res, 'Active disclosure version');
            return;
         }
         if (error instanceof OutdatedDisclosureVersionError) {
            sendConflict(res, error.message);
            return;
         }
         next(error);
      }
   }
);

/**
 * POST /v1/admin/disclosures/versions
 * Admin route to publish a new risk disclosure version, requiring acceptance again.
 */
disclosuresAdminRouter.post(
   '/versions',
   adminGuard,
   async (req: AdminRequest, res: Response, next: NextFunction) => {
      const parsed = publishDisclosureSchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid disclosure version payload',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      try {
         const created = await publishDisclosureVersion(
            parsed.data,
            req.adminId
         );
         sendSuccess(res, created, 201);
      } catch (error) {
         if (error instanceof DisclosureVersionExistsError) {
            sendConflict(res, error.message);
            return;
         }
         next(error);
      }
   }
);
