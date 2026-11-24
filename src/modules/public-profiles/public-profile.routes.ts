// src/modules/public-profiles/public-profile.routes.ts
// Owner settings (PUT/GET /me/public-profile) and the public portfolio view
// (GET /public/profiles/:handle) (#1355).

import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { envConfig } from '../../config';
import { requireJwtAuth, AuthenticatedRequest } from '../../middlewares/jwt-auth.middleware';
import {
   sendSuccess,
   sendError,
   sendValidationError,
   zodIssuesToDetails,
   ErrorCode,
   ErrorCodeType,
} from '../../utils/api-response.utils';
import { sendRateLimitError } from '../../utils/rate-limit-response.utils';
import { logger } from '../../utils/logger.utils';
import {
   getOwnPublicProfile,
   getPublicProfileView,
   upsertPublicProfile,
   PublicProfileError,
} from './public-profile.service';

const PUBLIC_PROFILE_RATE_WINDOW_MS = 60 * 1000;

const settingsSchema = z
   .object({
      handle: z.string().trim().min(1).max(64),
      enabled: z.boolean().optional(),
      showHoldings: z.boolean().optional(),
      showPnl: z.boolean().optional(),
      showKeyCount: z.boolean().optional(),
      showJoined: z.boolean().optional(),
      showWallet: z.boolean().optional(),
      showExactAmounts: z.boolean().optional(),
   })
   .strict();

/** Per-IP limit for the unauthenticated profile lookup, which also guards handle enumeration. */
export const publicProfileRateLimit = rateLimit({
   windowMs: PUBLIC_PROFILE_RATE_WINDOW_MS,
   max: envConfig.MODE === 'production' ? 60 : 600,
   standardHeaders: true,
   legacyHeaders: false,
   skip: () =>
      process.env.NODE_ENV === 'test' ||
      process.env.DISABLE_RATE_LIMIT === 'true' ||
      envConfig.MODE === 'test',
   handler: (req: Request, res: Response) => {
      logger.warn(
         { requestId: req.requestId, path: req.path },
         'Public profile rate limit exceeded'
      );
      sendRateLimitError(res, PUBLIC_PROFILE_RATE_WINDOW_MS / 1000);
   },
});

function handleProfileError(res: Response, error: unknown, context: string): void {
   if (error instanceof PublicProfileError) {
      sendError(res, error.statusCode, error.code as ErrorCodeType, error.message);
      return;
   }
   logger.error({ error }, context);
   sendError(res, 500, ErrorCode.INTERNAL_ERROR, context);
}

export const publicProfileMeRouter = Router();

publicProfileMeRouter.get(
   '/public-profile',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response) => {
      try {
         const profile = await getOwnPublicProfile(req.user!.wallet);
         sendSuccess(res, { profile });
      } catch (error) {
         handleProfileError(res, error, 'Failed to load public profile settings');
      }
   }
);

publicProfileMeRouter.put(
   '/public-profile',
   requireJwtAuth,
   async (req: AuthenticatedRequest, res: Response) => {
      const parsed = settingsSchema.safeParse(req.body);
      if (!parsed.success) {
         sendValidationError(
            res,
            'Invalid public profile settings',
            zodIssuesToDetails(parsed.error.issues)
         );
         return;
      }

      try {
         const profile = await upsertPublicProfile(req.user!.wallet, parsed.data);
         sendSuccess(res, { profile });
      } catch (error) {
         handleProfileError(res, error, 'Failed to save public profile settings');
      }
   }
);

export const publicProfilesRouter = Router();

publicProfilesRouter.get(
   '/profiles/:handle',
   publicProfileRateLimit,
   async (req: Request, res: Response) => {
      try {
         const profile = await getPublicProfileView(String(req.params.handle));
         if (!profile) {
            // Unknown and disabled handles share this exact response so the
            // endpoint cannot be used to discover registered handles.
            sendError(res, 404, ErrorCode.NOT_FOUND, 'Public profile not found');
            return;
         }
         sendSuccess(res, { profile });
      } catch (error) {
         handleProfileError(res, error, 'Failed to load public profile');
      }
   }
);
