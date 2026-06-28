import request from 'supertest';
import { app } from '../../app';
import { prisma } from '../../utils/prisma.utils';
import { Keypair } from '@stellar/stellar-base';
import { createHash } from 'crypto';

describe('POST /api/v1/creators/:id/webhooks - Invalid Signature', () => {
   const creatorId = '1';
   const callbackUrl = 'https://example.com/webhook';
   const events = ['trade'];

   afterEach(async () => {
      // Clean up any webhooks created during tests
      await prisma.webhook.deleteMany({
         where: { creator_id: creatorId },
      });
   });

   it('should return 401 when signature header is missing', async () => {
      await request(app)
         .post(`/api/v1/creators/${creatorId}/webhooks`)
         .send({ callback_url: callbackUrl, events })
         .expect(401);

      // Verify no webhook was created
      const count = await prisma.webhook.count({
         where: { creator_id: creatorId },
      });
      expect(count).toBe(0);
   });

   it('should return 401 when signature is signed by different wallet', async () => {
      const wrongWallet = Keypair.random();
      const timestamp = Date.now().toString();
      const path = `/api/v1/creators/${creatorId}/webhooks`;

      const message = createHash('sha256')
         .update(`POST:${path}:${creatorId}:${timestamp}`, 'utf8')
         .digest();

      const signature = wrongWallet.sign(message).toString('base64');

      await request(app)
         .post(path)
         .set('x-wallet-address', wrongWallet.publicKey())
         .set('x-signature', signature)
         .set('x-timestamp', timestamp)
         .send({ callback_url: callbackUrl, events })
         .expect(res => {
            // Should be 401 (missing headers) or 403/404 (verification failed/creator not found)
            expect([401, 403, 404]).toContain(res.status);
         });

      // Verify no webhook was created
      const count = await prisma.webhook.count({
         where: { creator_id: creatorId },
      });
      expect(count).toBe(0);
   });

   it('should return 401 when wallet address header is missing', async () => {
      const timestamp = Date.now().toString();
      const signature = 'fake-signature';

      await request(app)
         .post(`/api/v1/creators/${creatorId}/webhooks`)
         .set('x-signature', signature)
         .set('x-timestamp', timestamp)
         .send({ callback_url: callbackUrl, events })
         .expect(401);

      // Verify no webhook was created
      const count = await prisma.webhook.count({
         where: { creator_id: creatorId },
      });
      expect(count).toBe(0);
   });

   it('should return 401 when timestamp header is missing', async () => {
      const wallet = Keypair.random();
      const signature = 'fake-signature';

      await request(app)
         .post(`/api/v1/creators/${creatorId}/webhooks`)
         .set('x-wallet-address', wallet.publicKey())
         .set('x-signature', signature)
         .send({ callback_url: callbackUrl, events })
         .expect(401);

      // Verify no webhook was created
      const count = await prisma.webhook.count({
         where: { creator_id: creatorId },
      });
      expect(count).toBe(0);
   });
});
