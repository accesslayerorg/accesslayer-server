import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import {
   httpGetCreatorEmbedSettings,
   httpGetEmbedBadgeSvg,
   httpGetEmbedWidget,
   httpUpdateCreatorEmbedSettings,
} from './embed.controllers';
import { requireKeyCreator } from '../../middlewares/jwt-auth.middleware';
import { sendRateLimitError } from '../../utils/rate-limit-response.utils';
import { envConfig } from '../../config';

const EMBED_RATE_LIMIT_WINDOW_MS = 60 * 1000;

export const embedRateLimit = rateLimit({
   windowMs: EMBED_RATE_LIMIT_WINDOW_MS,
   max: 120,
   standardHeaders: true,
   legacyHeaders: false,
   skip: () =>
      process.env.NODE_ENV === 'test' ||
      process.env.DISABLE_RATE_LIMIT === 'true' ||
      envConfig.MODE === 'test',
   handler: (_req: Request, res: Response) => {
      sendRateLimitError(res, EMBED_RATE_LIMIT_WINDOW_MS / 1000);
   },
});

export const embedRouter = Router();
embedRouter.use(embedRateLimit);
embedRouter.get('/keys/:handle/badge.svg', httpGetEmbedBadgeSvg);
embedRouter.get('/keys/:handle/widget', httpGetEmbedWidget);

export const embedCreatorRouter = Router();
embedCreatorRouter.get(
   '/:id/embed-settings',
   requireKeyCreator('id'),
   httpGetCreatorEmbedSettings
);
embedCreatorRouter.put(
   '/:id/embed-settings',
   requireKeyCreator('id'),
   httpUpdateCreatorEmbedSettings
);
