import { Router } from 'express';
import { requireWalletSignature } from './webhook-signature.middleware';
import {
  registerWebhookHandler,
  listWebhooksHandler,
  deleteWebhookHandler,
} from './webhook.controllers';

const router = Router();

router.post(
  '/:id/webhooks',
  requireWalletSignature(),
  registerWebhookHandler
);

router.get(
  '/:id/webhooks',
  requireWalletSignature(),
  listWebhooksHandler
);

router.delete(
  '/:id/webhooks/:webhookId',
  requireWalletSignature(),
  deleteWebhookHandler
);

export default router;
