import supertest from 'supertest';
import app from '../../app';
import { prisma } from '../../utils/prisma.utils';
import { Keypair } from '@stellar/stellar-base';
import { createHash } from 'crypto';
import { envConfig } from '../../config';

const keypair = Keypair.random();
const walletAddress = keypair.publicKey();
const testUserId = 'webhook-test-user-id';
const creatorId = 'webhook-test-creator-id';

const keypairA = Keypair.random();
const walletAddressA = keypairA.publicKey();
const userIdA = 'webhook-isolation-user-a';
const creatorIdA = 'webhook-isolation-creator-a';

const keypairB = Keypair.random();
const walletAddressB = keypairB.publicKey();
const userIdB = 'webhook-isolation-user-b';
const creatorIdB = 'webhook-isolation-creator-b';

function signMessageFor(keypair: Keypair, method: string, path: string, cId: string, timestamp: string): string {
  const payload = `${method.toUpperCase()}:${path}:${cId}:${timestamp}`;
  const hash = createHash('sha256').update(payload, 'utf8').digest();
  return keypair.sign(hash).toString('base64');
}

function authHeadersFor(kp: Keypair, method: string, path: string, cId: string) {
  const timestamp = Date.now().toString();
  const signature = signMessageFor(kp, method, path, cId, timestamp);
  return {
    'x-wallet-address': kp.publicKey(),
    'x-signature': signature,
    'x-timestamp': timestamp,
  };
}
function signMessage(method: string, path: string, creatorId: string, timestamp: string): string {
  const payload = `${method.toUpperCase()}:${path}:${creatorId}:${timestamp}`;
  const hash = createHash('sha256').update(payload, 'utf8').digest();
  return keypair.sign(hash).toString('base64');
}

function authHeaders(method: string, path: string, cId: string) {
  const timestamp = Date.now().toString();
  const signature = signMessage(method, path, cId, timestamp);
  return {
    'x-wallet-address': walletAddress,
    'x-signature': signature,
    'x-timestamp': timestamp,
  };
}

beforeAll(async () => {
  await prisma.user.create({
    data: {
      id: testUserId,
      email: 'webhook-test@example.com',
      passwordHash: 'dummy-hash',
      firstName: 'Webhook',
      lastName: 'Test',
    },
  });

  await prisma.stellarWallet.create({
    data: {
      address: walletAddress,
      userId: testUserId,
    },
  });

  await prisma.creatorProfile.create({
    data: {
      id: creatorId,
      userId: testUserId,
      handle: 'webhook-test-creator',
      displayName: 'Webhook Test Creator',
    },
  });
});

afterAll(async () => {
  await prisma.webhookEvent.deleteMany({
    where: { webhook: { creatorId } },
  });
  await prisma.webhook.deleteMany({ where: { creatorId } });
  await prisma.creatorProfile.delete({ where: { id: creatorId } }).catch(() => {});
  await prisma.stellarWallet.delete({ where: { address: walletAddress } }).catch(() => {});
  await prisma.user.delete({ where: { id: testUserId } }).catch(() => {});
  await prisma.$disconnect();
});

describe('POST /api/v1/creators/:id/webhooks', () => {
  const basePath = `/api/v1/creators/${creatorId}/webhooks`;

  it('registers a webhook with valid signature and data', async () => {
    const res = await supertest(app)
      .post(basePath)
      .set(authHeaders('POST', basePath, creatorId))
      .send({ callback_url: 'https://example.com/hook', events: ['buy', 'sell'] });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.callbackUrl).toBe('https://example.com/hook');
    expect(res.body.data.events).toEqual(['buy', 'sell']);
  });

  it('returns 401 when signature headers missing', async () => {
    const res = await supertest(app)
      .post(basePath)
      .send({ callback_url: 'https://example.com/hook', events: ['buy'] });

    expect(res.status).toBe(401);
  });

  it('returns 400 on invalid body', async () => {
    const res = await supertest(app)
      .post(basePath)
      .set(authHeaders('POST', basePath, creatorId))
      .send({ callback_url: 'not-a-url', events: ['invalid'] });

    expect(res.status).toBe(400);
  });

  it('returns 409 when max webhooks reached', async () => {
    const existingCount = await prisma.webhook.count({
      where: { creatorId, isActive: true },
    });

    const remaining = envConfig.WEBHOOK_MAX_PER_CREATOR - existingCount;
    for (let i = 0; i < remaining; i++) {
      await supertest(app)
        .post(basePath)
        .set(authHeaders('POST', basePath, creatorId))
        .send({ callback_url: `https://example.com/hook-${i}`, events: ['buy'] });
    }

    const res = await supertest(app)
      .post(basePath)
      .set(authHeaders('POST', basePath, creatorId))
      .send({ callback_url: 'https://example.com/too-many', events: ['buy'] });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('MAX_WEBHOOKS_REACHED');
  });
});

describe('GET /api/v1/creators/:id/webhooks', () => {
  const basePath = `/api/v1/creators/${creatorId}/webhooks`;

  it('lists webhooks for the creator', async () => {
    const res = await supertest(app)
      .get(basePath)
      .set(authHeaders('GET', basePath, creatorId));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('returns 401 without auth', async () => {
    const res = await supertest(app).get(basePath);
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/v1/creators/:id/webhooks/:webhookId', () => {
  it('deletes a webhook', async () => {
    const listRes = await supertest(app)
      .get(`/api/v1/creators/${creatorId}/webhooks`)
      .set(authHeaders('GET', `/api/v1/creators/${creatorId}/webhooks`, creatorId));

    const webhookId = listRes.body.data[0].id;

    const deleteRes = await supertest(app)
      .delete(`/api/v1/creators/${creatorId}/webhooks/${webhookId}`)
      .set(authHeaders('DELETE', `/api/v1/creators/${creatorId}/webhooks/${webhookId}`, creatorId));

    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.success).toBe(true);

    const verifyRes = await supertest(app)
      .get(`/api/v1/creators/${creatorId}/webhooks`)
      .set(authHeaders('GET', `/api/v1/creators/${creatorId}/webhooks`, creatorId));

    const ids = verifyRes.body.data.map((w: any) => w.id);
    expect(ids).not.toContain(webhookId);
  });

  it('returns 404 for non-existent webhook', async () => {
    const res = await supertest(app)
      .delete(`/api/v1/creators/${creatorId}/webhooks/non-existent-id`)
      .set(authHeaders('DELETE', `/api/v1/creators/${creatorId}/webhooks/non-existent-id`, creatorId));

    expect(res.status).toBe(404);
  });
});

describe('webhook dispatch', () => {
  let webhookId: string;

  beforeAll(async () => {
    const webhook = await prisma.webhook.create({
      data: {
        id: 'webhook-dispatch-test',
        creatorId,
        callbackUrl: 'https://httpbin.org/post',
        events: { set: ['BUY', 'SELL'] },
      },
    });
    webhookId = webhook.id;
  });

  afterAll(async () => {
    await prisma.webhookEvent.deleteMany({ where: { webhookId } });
    await prisma.webhook.delete({ where: { id: webhookId } }).catch(() => {});
  });

  it('dispatches a buy event and creates a WebhookEvent record', async () => {
    const { dispatchWebhookEvent } = await import('./webhook.service');

    await dispatchWebhookEvent({
      type: 'buy',
      creatorId,
      buyerOrSellerAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      amount: '100',
      price: '10.5',
      feePaid: '0.5',
      timestamp: new Date().toISOString(),
    });

    const events = await prisma.webhookEvent.findMany({
      where: { webhookId, eventType: 'BUY' },
      orderBy: { createdAt: 'desc' },
    });

    expect(events.length).toBeGreaterThan(0);
  });

  it('dispatches a sell event and creates a WebhookEvent record', async () => {
    const { dispatchWebhookEvent } = await import('./webhook.service');

    await dispatchWebhookEvent({
      type: 'sell',
      creatorId,
      buyerOrSellerAddress: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWBH',
      amount: '50',
      price: '20.0',
      feePaid: '1.0',
      timestamp: new Date().toISOString(),
    });

    const events = await prisma.webhookEvent.findMany({
      where: { webhookId, eventType: 'SELL' },
      orderBy: { createdAt: 'desc' },
    });

    expect(events.length).toBeGreaterThan(0);
  });

  it('respects event type filter — buy-only webhook does not receive sell events', async () => {
    const buyOnlyWebhook = await prisma.webhook.create({
      data: {
        id: 'webhook-filter-buy',
        creatorId,
        callbackUrl: 'https://httpbin.org/post',
        events: { set: ['BUY'] },
      },
    });

    const { dispatchWebhookEvent } = await import('./webhook.service');

    await dispatchWebhookEvent({
      type: 'sell',
      creatorId,
      buyerOrSellerAddress: 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCF',
      amount: '25',
      price: '30.0',
      feePaid: '0.75',
      timestamp: new Date().toISOString(),
    });

    const events = await prisma.webhookEvent.findMany({
      where: { webhookId: buyOnlyWebhook.id, eventType: 'SELL' },
    });

    expect(events.length).toBe(0);

    await prisma.webhookEvent.deleteMany({ where: { webhookId: buyOnlyWebhook.id } });
    await prisma.webhook.delete({ where: { id: buyOnlyWebhook.id } });
  });

  it('retries delivery on failure and flags webhook as failing after exhaustion', async () => {
    const failingWebhook = await prisma.webhook.create({
      data: {
        id: 'webhook-retry-test',
        creatorId,
        callbackUrl: 'https://nonexistent.example.com/fail',
        events: { set: ['BUY'] },
      },
    });

    const { dispatchWebhookEvent } = await import('./webhook.service');

    await dispatchWebhookEvent({
      type: 'buy',
      creatorId,
      buyerOrSellerAddress: 'GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDH',
      amount: '10',
      price: '5.0',
      feePaid: '0.25',
      timestamp: new Date().toISOString(),
    });

    await new Promise((resolve) => setTimeout(resolve, 15000));

    const updated = await prisma.webhook.findUnique({
      where: { id: failingWebhook.id },
      select: { isFailing: true },
    });

    expect(updated?.isFailing).toBe(true);

    const events = await prisma.webhookEvent.findMany({
      where: { webhookId: failingWebhook.id },
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].status).toBe('FAILED');
    expect(events[0].retryCount).toBe(envConfig.WEBHOOK_RETRY_MAX_ATTEMPTS);

    await prisma.webhookEvent.deleteMany({ where: { webhookId: failingWebhook.id } });
    await prisma.webhook.delete({ where: { id: failingWebhook.id } });
  }, 30000);
});

describe('GET /api/v1/creators/:id/webhooks — isolation between creators (#474)', () => {
  beforeAll(async () => {
    for (const [userId, email, walletAddr, cId, handle, displayName] of [
      [userIdA, 'webhook-isolation-a@example.com', walletAddressA, creatorIdA, 'isolation-creator-a', 'Isolation Creator A'],
      [userIdB, 'webhook-isolation-b@example.com', walletAddressB, creatorIdB, 'isolation-creator-b', 'Isolation Creator B'],
    ] as const) {
      await prisma.user.create({
        data: { id: userId, email, passwordHash: 'dummy-hash', firstName: 'Isolation', lastName: 'Test' },
      });
      await prisma.stellarWallet.create({ data: { address: walletAddr, userId } });
      await prisma.creatorProfile.create({ data: { id: cId, userId, handle, displayName } });
    }

    const pathA = `/api/v1/creators/${creatorIdA}/webhooks`;
    const pathB = `/api/v1/creators/${creatorIdB}/webhooks`;

    await supertest(app)
      .post(pathA)
      .set(authHeadersFor(keypairA, 'POST', pathA, creatorIdA))
      .send({ callback_url: 'https://example.com/hook-a1', events: ['buy'] });

    await supertest(app)
      .post(pathA)
      .set(authHeadersFor(keypairA, 'POST', pathA, creatorIdA))
      .send({ callback_url: 'https://example.com/hook-a2', events: ['sell'] });

    await supertest(app)
      .post(pathB)
      .set(authHeadersFor(keypairB, 'POST', pathB, creatorIdB))
      .send({ callback_url: 'https://example.com/hook-b1', events: ['buy', 'sell'] });
  });

  afterAll(async () => {
    await prisma.webhook.deleteMany({ where: { creatorId: creatorIdA } });
    await prisma.webhook.deleteMany({ where: { creatorId: creatorIdB } });
    for (const [cId, walletAddr, userId] of [
      [creatorIdA, walletAddressA, userIdA],
      [creatorIdB, walletAddressB, userIdB],
    ] as const) {
      await prisma.creatorProfile.delete({ where: { id: cId } }).catch(() => {});
      await prisma.stellarWallet.delete({ where: { address: walletAddr } }).catch(() => {});
      await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    }
  });

  it("creator A's webhook list contains no webhooks from creator B", async () => {
    const pathA = `/api/v1/creators/${creatorIdA}/webhooks`;
    const res = await supertest(app)
      .get(pathA)
      .set(authHeadersFor(keypairA, 'GET', pathA, creatorIdA));

    expect(res.status).toBe(200);
    const webhooks = res.body.data as Array<{ creatorId?: string; callbackUrl: string }>;
    expect(webhooks.every((w) => !w.callbackUrl.includes('hook-b'))).toBe(true);
  });

  it("creator B's webhook list contains no webhooks from creator A", async () => {
    const pathB = `/api/v1/creators/${creatorIdB}/webhooks`;
    const res = await supertest(app)
      .get(pathB)
      .set(authHeadersFor(keypairB, 'GET', pathB, creatorIdB));

    expect(res.status).toBe(200);
    const webhooks = res.body.data as Array<{ callbackUrl: string }>;
    expect(webhooks.every((w) => !w.callbackUrl.includes('hook-a'))).toBe(true);
  });

  it("count for creator A matches the number of webhooks registered for A", async () => {
    const pathA = `/api/v1/creators/${creatorIdA}/webhooks`;
    const res = await supertest(app)
      .get(pathA)
      .set(authHeadersFor(keypairA, 'GET', pathA, creatorIdA));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });

  it("count for creator B matches the number of webhooks registered for B", async () => {
    const pathB = `/api/v1/creators/${creatorIdB}/webhooks`;
    const res = await supertest(app)
      .get(pathB)
      .set(authHeadersFor(keypairB, 'GET', pathB, creatorIdB));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});
