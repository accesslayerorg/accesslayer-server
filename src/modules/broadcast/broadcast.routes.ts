import { Router } from 'express';
import { jwtAuth } from '../../middlewares/jwt.middleware';
import { requireKeyCreator } from '../../middlewares/jwt-auth.middleware';
import {
   httpConfirmBroadcastConsent,
   httpCreateBroadcast,
   httpGetCreatorBroadcasts,
   httpHandleBounceWebhook,
   httpPreviewBroadcastAudience,
   httpPutBroadcastConsent,
   httpUnsubscribeBroadcast,
} from './broadcast.controllers';

export const broadcastMeRouter = Router();
broadcastMeRouter.put(
   '/broadcast-consent/:keyId',
   jwtAuth,
   httpPutBroadcastConsent
);

export const broadcastPublicRouter = Router();
broadcastPublicRouter.get('/confirm', httpConfirmBroadcastConsent);
broadcastPublicRouter.get('/unsubscribe', httpUnsubscribeBroadcast);
broadcastPublicRouter.post('/unsubscribe', httpUnsubscribeBroadcast);
broadcastPublicRouter.post('/webhooks/bounce', httpHandleBounceWebhook);

export const broadcastCreatorRouter = Router();
broadcastCreatorRouter.post(
   '/:id/broadcasts/preview',
   requireKeyCreator('id'),
   httpPreviewBroadcastAudience
);
broadcastCreatorRouter.post(
   '/:id/broadcasts',
   requireKeyCreator('id'),
   httpCreateBroadcast
);
broadcastCreatorRouter.get('/:handle/broadcasts', httpGetCreatorBroadcasts);
