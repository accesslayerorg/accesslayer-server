// src/modules/webhooks/webhook-registration-url-validation.integration.test.ts
// Integration tests for #613 — webhook registration rejects invalid callback URLs.
//
// Found while scoping this issue: CreateWebhookSchema previously only checked
// `z.string().url()`, which accepts plain-HTTP and hostless URLs. Strengthened
// in webhook.schemas.ts to require https:// and a non-empty host — these tests
// cover both the pre-existing "not a URL at all" case and the two new checks.

import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';
import { Keypair } from '@stellar/stellar-base';
import { createHash } from 'crypto';

const keypair = Keypair.random();
const walletAddress = keypair.publicKey();
const userId = 'webhook-url-validation-user';
const creatorId = 'webhook-url-validation-creator';

function authHeaders(method: string, path: string, cId: string) {
   const timestamp = Date.now().toString();
   const payload = `${method.toUpperCase()}:${path}:${cId}:${timestamp}`;
   const hash = createHash('sha256').update(payload, 'utf8').digest();
   const signature = keypair.sign(hash).toString('base64');
   return {
      'x-wallet-address': walletAddress,
      'x-signature': signature,
      'x-timestamp': timestamp,
   };
}

beforeAll(async () => {
   await prisma.user.create({
      data: {
         id: userId,
         email: 'webhook-url-validation@example.test',
         passwordHash: 'dummy-hash',
         firstName: 'UrlValidation',
         lastName: 'Test',
      },
   });

   await prisma.stellarWallet.create({
      data: { address: walletAddress, userId },
   });

   await prisma.creatorProfile.create({
      data: {
         id: creatorId,
         userId,
         handle: 'webhook-url-validation-creator',
         displayName: 'Webhook URL Validation Creator',
      },
   });
});

afterAll(async () => {
   await prisma.webhookEvent.deleteMany({ where: { webhook: { creatorId } } });
   await prisma.webhook.deleteMany({ where: { creatorId } });
   await prisma.creatorProfile
      .delete({ where: { id: creatorId } })
      .catch(() => {});
   await prisma.stellarWallet
      .delete({ where: { address: walletAddress } })
      .catch(() => {});
   await prisma.user.delete({ where: { id: userId } }).catch(() => {});
   await prisma.$disconnect();
});

describe('#613 POST /api/v1/creators/:id/webhooks — callback_url validation', () => {
   const basePath = `/api/v1/creators/${creatorId}/webhooks`;

   it('rejects an http:// (non-HTTPS) URL with 400 and a field-level message', async () => {
      const res = await supertest(app)
         .post(basePath)
         .set(authHeaders('POST', basePath, creatorId))
         .send({ callback_url: 'http://example.com/hook', events: ['buy'] });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      const fields = res.body.error.details.map((d: any) => d.field);
      expect(fields).toContain('callback_url');
   });

   it('rejects a URL with no host with 400', async () => {
      const res = await supertest(app)
         .post(basePath)
         .set(authHeaders('POST', basePath, creatorId))
         .send({ callback_url: 'https://', events: ['buy'] });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      const fields = res.body.error.details.map((d: any) => d.field);
      expect(fields).toContain('callback_url');
   });

   it('rejects a plain string that is not a URL with 400', async () => {
      const res = await supertest(app)
         .post(basePath)
         .set(authHeaders('POST', basePath, creatorId))
         .send({ callback_url: 'not-a-url-at-all', events: ['buy'] });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      const fields = res.body.error.details.map((d: any) => d.field);
      expect(fields).toContain('callback_url');
   });

   it('accepts a valid HTTPS URL and returns 201', async () => {
      const res = await supertest(app)
         .post(basePath)
         .set(authHeaders('POST', basePath, creatorId))
         .send({
            callback_url: 'https://example.com/url-validation-hook',
            events: ['buy'],
         });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.callbackUrl).toBe(
         'https://example.com/url-validation-hook'
      );
   });
});
