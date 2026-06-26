// src/__tests__/integration/webhook-max-limit.integration.test.ts
// Integration test for #487: webhook max registration limit enforcement.

import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';
import { Keypair } from '@stellar/stellar-base';
import { createHash } from 'crypto';
import { envConfig } from '../../config';

const keypair = Keypair.random();
const walletAddress = keypair.publicKey();
const userId = 'webhook-max-limit-user';
const creatorId = 'webhook-max-limit-creator';
const basePath = `/api/v1/creators/${creatorId}/webhooks`;

function authHeaders(method: string, path: string) {
  const timestamp = Date.now().toString();
  const payload = `${method.toUpperCase()}:${path}:${creatorId}:${timestamp}`;
  const hash = createHash('sha256').update(payload, 'utf8').digest();
  const signature = keypair.sign(hash).toString('base64');
  return { 'x-wallet-address': walletAddress, 'x-signature': signature, 'x-timestamp': timestamp };
}

beforeAll(async () => {
  await prisma.user.create({
    data: { id: userId, email: 'webhook-max-limit@example.com', passwordHash: 'dummy', firstName: 'Max', lastName: 'Limit' },
  });
  await prisma.stellarWallet.create({ data: { address: walletAddress, userId } });
  await prisma.creatorProfile.create({ data: { id: creatorId, userId, handle: 'webhook-max-limit', displayName: 'Max Limit Creator' } });
});

afterAll(async () => {
  await prisma.webhook.deleteMany({ where: { creatorId } });
  await prisma.creatorProfile.delete({ where: { id: creatorId } }).catch(() => {});
  await prisma.stellarWallet.delete({ where: { address: walletAddress } }).catch(() => {});
  await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  await prisma.$disconnect();
});

describe('webhook max registration limit (#487)', () => {
  it('registers webhooks up to the configured maximum', async () => {
    for (let i = 0; i < envConfig.WEBHOOK_MAX_PER_CREATOR; i++) {
      const res = await supertest(app)
        .post(basePath)
        .set(authHeaders('POST', basePath))
        .send({ callback_url: `https://example.com/hook-${i}`, events: ['buy'] });

      expect(res.status).toBe(201);
    }

    const count = await prisma.webhook.count({ where: { creatorId, isActive: true } });
    expect(count).toBe(envConfig.WEBHOOK_MAX_PER_CREATOR);
  });

  it('returns 422 when attempting to register beyond the limit', async () => {
    const res = await supertest(app)
      .post(basePath)
      .set(authHeaders('POST', basePath))
      .send({ callback_url: 'https://example.com/over-limit', events: ['buy'] });

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('MAX_WEBHOOKS_REACHED');
    expect(res.body.error.message).toMatch(/maximum/i);
  });

  it('does not increase the webhook count after the failed registration', async () => {
    const count = await prisma.webhook.count({ where: { creatorId, isActive: true } });
    expect(count).toBe(envConfig.WEBHOOK_MAX_PER_CREATOR);
  });
});
