import { Router } from 'express';
import { requireWalletSignature } from './webhook-signature.middleware';
import {
   registerWebhookHandler,
   listWebhooksHandler,
   deleteWebhookHandler,
   getWebhookHandler,
   updateWebhookHandler,
} from './webhook.controllers';

const router = Router();

router.post('/:id/webhooks', requireWalletSignature(), registerWebhookHandler);

router.get('/:id/webhooks', requireWalletSignature(), listWebhooksHandler);

router.get(
   '/:id/webhooks/:webhookId',
   requireWalletSignature(),
   getWebhookHandler
);

router.patch(
   '/:id/webhooks/:webhookId',
   requireWalletSignature(),
   updateWebhookHandler
);

router.delete(
   '/:id/webhooks/:webhookId',
   requireWalletSignature(),
   deleteWebhookHandler
);

export default router;
