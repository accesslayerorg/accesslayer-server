// src/modules/notifications/notification-preference.api.test.ts
// Tests for notification preference API endpoints, wallet-signature auth, and tokens (#1217).

const mockPreferences = new Map<string, any>();

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      notificationPreference: {
         create: jest.fn(async ({ data }: any) => {
            const item = {
               id: `pref-${Date.now()}-${Math.random()}`,
               ...data,
               createdAt: new Date(),
               updatedAt: new Date(),
            };
            mockPreferences.set(data.wallet, item);
            return item;
         }),
         findUnique: jest.fn(async ({ where }: any) => {
            return mockPreferences.get(where.wallet) || null;
         }),
         upsert: jest.fn(async ({ where, create, update }: any) => {
            const existing = mockPreferences.get(where.wallet);
            if (existing) {
               const updated = { ...existing, ...update, updatedAt: new Date() };
               mockPreferences.set(where.wallet, updated);
               return updated;
            } else {
               const created = {
                  id: `pref-${Date.now()}-${Math.random()}`,
                  ...create,
                  createdAt: new Date(),
                  updatedAt: new Date(),
               };
               mockPreferences.set(where.wallet, created);
               return created;
            }
         }),
         update: jest.fn(async ({ where, data }: any) => {
            const existing = mockPreferences.get(where.wallet);
            if (!existing) throw new Error('Not found');
            const updated = { ...existing, ...data, updatedAt: new Date() };
            mockPreferences.set(where.wallet, updated);
            return updated;
         }),
         deleteMany: jest.fn(async () => {
            mockPreferences.clear();
            return { count: 0 };
         }),
      },
   },
}));

import supertest from 'supertest';
import { Keypair } from '@stellar/stellar-base';
import { createHash } from 'crypto';
import express from 'express';
import { prisma } from '../../utils/prisma.utils';
import { LogMailer } from '../../services/email/mailer.service';
import { notificationPreferenceService } from './notification-preference.service';
import {
   httpGetNotificationPreferences,
   httpUpdateNotificationPreferences,
   httpVerifyNotificationEmail,
   httpUnsubscribeNotificationDigest,
} from './notification-preference.controllers';
import { requireStellarSignature } from '../../middlewares/stellar-signature.middleware';
import {
   createVerificationToken,
   createUnsubscribeToken,
   VERIFICATION_TOKEN_TTL_MS,
} from './notification-preference.tokens';

// Create dedicated test app for notifications
const testApp = express();
testApp.use(express.json());

testApp.put(
   '/v1/wallets/:address/notifications',
   requireStellarSignature(),
   httpUpdateNotificationPreferences
);
testApp.get(
   '/v1/wallets/:address/notifications',
   requireStellarSignature(),
   httpGetNotificationPreferences
);
testApp.get('/v1/notifications/verify', httpVerifyNotificationEmail);
testApp.get('/v1/notifications/unsubscribe', httpUnsubscribeNotificationDigest);

testApp.use((err: any, _req: any, res: any, _next: any) => {
   console.error('SERVER ERROR IN TEST:', err);
   res.status(500).json({ error: err.message, stack: err.stack });
});

function signRequest(keypair: Keypair, body: unknown, addressOverride?: string) {
   const timestamp = Date.now().toString();
   const bodyJson = JSON.stringify(body);
   const payload = `${bodyJson}${timestamp}`;
   const message = createHash('sha256').update(payload, 'utf8').digest();
   const signature = keypair.sign(message).toString('base64');

   return {
      'x-wallet-address': addressOverride || keypair.publicKey(),
      'x-wallet-signature': signature,
      'x-timestamp': timestamp,
   };
}

describe('Notification Preferences API', () => {
   let keypair: Keypair;
   let wallet: string;
   let logMailer: LogMailer;

   beforeEach(async () => {
      mockPreferences.clear();
      keypair = Keypair.random();
      wallet = keypair.publicKey();
      logMailer = new LogMailer();
      notificationPreferenceService.setDefaultDeps({ mailer: logMailer });
   });

   describe('PUT /v1/wallets/:address/notifications', () => {
      it('rejects when signed wallet does not match :address with 403', async () => {
         const otherKeypair = Keypair.random();
         const body = {
            email: 'user@example.com',
            frequency: 'daily',
            events: ['KEY_BOUGHT'],
         };
         const headers = signRequest(keypair, body);

         const res = await supertest(testApp)
            .put(`/v1/wallets/${otherKeypair.publicKey()}/notifications`)
            .set(headers)
            .send(body);

         expect(res.status).toBe(403);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('FORBIDDEN');
      });

      it('rejects invalid payloads with 400 (bad email, invalid frequency, invalid event types)', async () => {
         // Bad email
         let body: any = {
            email: 'not-an-email',
            frequency: 'daily',
            events: ['KEY_BOUGHT'],
         };
         let res = await supertest(testApp)
            .put(`/v1/wallets/${wallet}/notifications`)
            .set(signRequest(keypair, body))
            .send(body);
         expect(res.status).toBe(400);

         // Bad frequency
         body = {
            email: 'valid@example.com',
            frequency: 'monthly', // Invalid
            events: ['KEY_BOUGHT'],
         };
         res = await supertest(testApp)
            .put(`/v1/wallets/${wallet}/notifications`)
            .set(signRequest(keypair, body))
            .send(body);
         expect(res.status).toBe(400);

         // Bad event type
         body = {
            email: 'valid@example.com',
            frequency: 'daily',
            events: ['NOT_A_REAL_EVENT'],
         };
         res = await supertest(testApp)
            .put(`/v1/wallets/${wallet}/notifications`)
            .set(signRequest(keypair, body))
            .send(body);
         expect(res.status).toBe(400);
      });

      it('creates preferences and sends verification email on initial configuration', async () => {
         const body = {
            email: 'alice@example.com',
            frequency: 'daily',
            events: ['KEY_BOUGHT', 'KEY_SOLD'],
         };

         const res = await supertest(testApp)
            .put(`/v1/wallets/${wallet}/notifications`)
            .set(signRequest(keypair, body))
            .send(body);

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data.preference.email).toBe('alice@example.com');
         expect(res.body.data.preference.verifiedAt).toBeNull();
         expect(res.body.data.preference.events).toEqual(['KEY_BOUGHT', 'KEY_SOLD']);
      });

      it('email change resets verifiedAt and sends a new verification email', async () => {
         // 1. Initial creation
         const body1 = {
            email: 'initial@example.com',
            frequency: 'daily',
            events: ['KEY_BOUGHT'],
         };
         await supertest(testApp)
            .put(`/v1/wallets/${wallet}/notifications`)
            .set(signRequest(keypair, body1))
            .send(body1);

         // 2. Simulate email was verified
         await prisma.notificationPreference.update({
            where: { wallet },
            data: { verifiedAt: new Date() },
         });

         // 3. Update with a changed email
         const body2 = {
            email: 'updated@example.com',
            frequency: 'daily',
            events: ['KEY_BOUGHT'],
         };
         const res = await supertest(testApp)
            .put(`/v1/wallets/${wallet}/notifications`)
            .set(signRequest(keypair, body2))
            .send(body2);

         expect(res.status).toBe(200);
         expect(res.body.data.preference.email).toBe('updated@example.com');
         expect(res.body.data.preference.verifiedAt).toBeNull(); // Reset!

         // Verify in DB
         const inDb = await prisma.notificationPreference.findUnique({ where: { wallet } });
         expect(inDb?.verifiedAt).toBeNull();
      });

      it('updating settings with the same email preserves verifiedAt status', async () => {
         // 1. Setup verified preference
         const verifiedDate = new Date('2026-11-20T10:00:00.000Z');
         await prisma.notificationPreference.create({
            data: {
               wallet,
               email: 'staythesame@example.com',
               frequency: 'daily',
               events: ['KEY_BOUGHT'],
               verifiedAt: verifiedDate,
            },
         });

         // 2. Change frequency and events only
         const body = {
            email: 'staythesame@example.com',
            frequency: 'weekly',
            events: ['KEY_BOUGHT', 'KEY_SOLD', 'DIVIDEND_DISTRIBUTED'],
         };
         const res = await supertest(testApp)
            .put(`/v1/wallets/${wallet}/notifications`)
            .set(signRequest(keypair, body))
            .send(body);

         expect(res.status).toBe(200);
         expect(res.body.data.preference.frequency).toBe('weekly');
         expect(res.body.data.preference.verifiedAt).toBe(verifiedDate.toISOString());
      });
   });

   describe('GET /v1/wallets/:address/notifications', () => {
      it('rejects signed wallet mismatch with 403', async () => {
         const otherKeypair = Keypair.random();
         const body = {};
         const headers = signRequest(keypair, body);

         const res = await supertest(testApp)
            .get(`/v1/wallets/${otherKeypair.publicKey()}/notifications`)
            .set(headers)
            .send(body);

         expect(res.status).toBe(403);
      });

      it('returns existing notification preferences for authorized wallet', async () => {
         await prisma.notificationPreference.create({
            data: {
               wallet,
               email: 'reader@example.com',
               frequency: 'daily',
               events: ['KEY_BOUGHT'],
            },
         });

         const body = {};
         const headers = signRequest(keypair, body);

         const res = await supertest(testApp)
            .get(`/v1/wallets/${wallet}/notifications`)
            .set(headers)
            .send(body);

         expect(res.status).toBe(200);
         expect(res.body.data.email).toBe('reader@example.com');
         expect(res.body.data.wallet).toBe(wallet);
      });
   });

   describe('GET /v1/notifications/verify', () => {
      it('verifies email with valid 24h token and sets verifiedAt', async () => {
         await prisma.notificationPreference.create({
            data: {
               wallet,
               email: 'bob@example.com',
               frequency: 'daily',
               events: ['KEY_BOUGHT'],
               verifiedAt: null,
            },
         });

         const now = Date.now();
         const token = createVerificationToken(wallet, 'bob@example.com', now);

         const res = await supertest(testApp).get(`/v1/notifications/verify?token=${token}`);

         expect(res.status).toBe(200);
         expect(res.body.data.verified).toBe(true);
         expect(res.body.data.verifiedAt).not.toBeNull();

         const updated = await prisma.notificationPreference.findUnique({ where: { wallet } });
         expect(updated?.verifiedAt).not.toBeNull();
      });

      it('rejects expired verification token (> 24 hours)', async () => {
         await prisma.notificationPreference.create({
            data: {
               wallet,
               email: 'expired@example.com',
               frequency: 'daily',
               events: ['KEY_BOUGHT'],
               verifiedAt: null,
            },
         });

         const token = createVerificationToken(
            wallet,
            'expired@example.com',
            Date.now() - (VERIFICATION_TOKEN_TTL_MS + 60_000)
         );

         const res = await supertest(testApp).get(`/v1/notifications/verify?token=${token}`);
         expect(res.status).toBe(400);
         expect(res.body.error.message).toContain('expired');
      });

      it('rejects tampered or wrong-purpose tokens', async () => {
         const unsubToken = createUnsubscribeToken(wallet);
         let res = await supertest(testApp).get(`/v1/notifications/verify?token=${unsubToken}`);
         expect(res.status).toBe(400);
         expect(res.body.error.message).toContain('purpose');

         const validToken = createVerificationToken(wallet, 'user@example.com');
         const tampered = validToken + 'evil';
         res = await supertest(testApp).get(`/v1/notifications/verify?token=${tampered}`);
         expect(res.status).toBe(400);
      });

      it('rejects old token if the email was changed in the meantime', async () => {
         const oldToken = createVerificationToken(wallet, 'old@example.com');

         await prisma.notificationPreference.create({
            data: {
               wallet,
               email: 'new@example.com',
               frequency: 'daily',
               events: ['KEY_BOUGHT'],
               verifiedAt: null,
            },
         });

         const res = await supertest(testApp).get(`/v1/notifications/verify?token=${oldToken}`);
         expect(res.status).toBe(400);
         expect(res.body.error.message).toContain('previous email address');
      });
   });

   describe('GET /v1/notifications/unsubscribe', () => {
      it('unsubscribes user without login using one-click signed link', async () => {
         await prisma.notificationPreference.create({
            data: {
               wallet,
               email: 'unsubme@example.com',
               frequency: 'daily',
               events: ['KEY_BOUGHT'],
               verifiedAt: new Date(),
               unsubscribedAt: null,
            },
         });

         const unsubToken = createUnsubscribeToken(wallet);
         const res = await supertest(testApp).get(
            `/v1/notifications/unsubscribe?token=${unsubToken}`
         );

         expect(res.status).toBe(200);
         expect(res.body.data.unsubscribed).toBe(true);

         const updated = await prisma.notificationPreference.findUnique({ where: { wallet } });
         expect(updated?.unsubscribedAt).not.toBeNull();
      });

      it('rejects wrong-purpose token or tampered token', async () => {
         const verifyToken = createVerificationToken(wallet, 'test@example.com');
         const res = await supertest(testApp).get(
            `/v1/notifications/unsubscribe?token=${verifyToken}`
         );

         expect(res.status).toBe(400);
         expect(res.body.error.message).toContain('purpose');
      });
   });
});
