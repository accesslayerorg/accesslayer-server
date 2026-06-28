// Integration test: webhook event type filter enforced at delivery time (#461)
//
// Verifies that:
//   1. A buy-only webhook does NOT fire when a sell event occurs
//   2. A buy-only webhook DOES fire when a buy event occurs
//   3. A sell-only webhook does NOT fire when a buy event occurs
//   4. A sell-only webhook DOES fire when a sell event occurs

import { prisma } from '../../utils/prisma.utils';
import { Keypair } from '@stellar/stellar-base';

const keypair = Keypair.random();
const walletAddress = keypair.publicKey();
const testUserId = 'webhook-filter-test-user';
const creatorId = 'webhook-filter-test-creator';

const BASE_TRADE = {
  creatorId,
  buyerOrSellerAddress: 'GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDH',
  amount: '10',
  price: '5.0',
  feePaid: '0.25',
  timestamp: new Date().toISOString(),
};

beforeAll(async () => {
  await prisma.user.create({
    data: {
      id: testUserId,
      email: 'webhook-filter-test@example.com',
      passwordHash: 'dummy-hash',
      firstName: 'Filter',
      lastName: 'Test',
    },
  });
  await prisma.stellarWallet.create({
    data: { address: walletAddress, userId: testUserId },
  });
  await prisma.creatorProfile.create({
    data: {
      id: creatorId,
      userId: testUserId,
      handle: 'filter-test-creator',
      displayName: 'Filter Test Creator',
    },
  });
});

afterAll(async () => {
  await prisma.webhookEvent.deleteMany({ where: { webhook: { creatorId } } });
  await prisma.webhook.deleteMany({ where: { creatorId } });
  await prisma.creatorProfile.deleteMany({ where: { id: creatorId } });
  await prisma.stellarWallet.deleteMany({ where: { userId: testUserId } });
  await prisma.user.deleteMany({ where: { id: testUserId } });
});

describe('Webhook event type filter — buy-only webhook', () => {
  let buyOnlyWebhookId: string;

  beforeEach(async () => {
    const wh = await prisma.webhook.create({
      data: {
        creatorId,
        callbackUrl: 'https://example.com/callback',
        events: { set: ['BUY'] },
      },
    });
    buyOnlyWebhookId = wh.id;
  });

  afterEach(async () => {
    await prisma.webhookEvent.deleteMany({ where: { webhookId: buyOnlyWebhookId } });
    await prisma.webhook.delete({ where: { id: buyOnlyWebhookId } });
  });

  it('does NOT create a WebhookEvent record when a sell event occurs (buy-only filter)', async () => {
    const { dispatchWebhookEvent } = await import('./webhook.service');

    await dispatchWebhookEvent({ ...BASE_TRADE, type: 'sell' });

    const events = await prisma.webhookEvent.findMany({
      where: { webhookId: buyOnlyWebhookId, eventType: 'SELL' },
    });
    expect(events).toHaveLength(0);
  });

  it('DOES create a WebhookEvent record when a buy event occurs (buy-only filter)', async () => {
    const { dispatchWebhookEvent } = await import('./webhook.service');

    await dispatchWebhookEvent({ ...BASE_TRADE, type: 'buy' });

    const events = await prisma.webhookEvent.findMany({
      where: { webhookId: buyOnlyWebhookId, eventType: 'BUY' },
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].eventType).toBe('BUY');
  });
});

describe('Webhook event type filter — sell-only webhook', () => {
  let sellOnlyWebhookId: string;

  beforeEach(async () => {
    const wh = await prisma.webhook.create({
      data: {
        creatorId,
        callbackUrl: 'https://example.com/callback',
        events: { set: ['SELL'] },
      },
    });
    sellOnlyWebhookId = wh.id;
  });

  afterEach(async () => {
    await prisma.webhookEvent.deleteMany({ where: { webhookId: sellOnlyWebhookId } });
    await prisma.webhook.delete({ where: { id: sellOnlyWebhookId } });
  });

  it('does NOT create a WebhookEvent record when a buy event occurs (sell-only filter)', async () => {
    const { dispatchWebhookEvent } = await import('./webhook.service');

    await dispatchWebhookEvent({ ...BASE_TRADE, type: 'buy' });

    const events = await prisma.webhookEvent.findMany({
      where: { webhookId: sellOnlyWebhookId, eventType: 'BUY' },
    });
    expect(events).toHaveLength(0);
  });

  it('DOES create a WebhookEvent record when a sell event occurs (sell-only filter)', async () => {
    const { dispatchWebhookEvent } = await import('./webhook.service');

    await dispatchWebhookEvent({ ...BASE_TRADE, type: 'sell' });

    const events = await prisma.webhookEvent.findMany({
      where: { webhookId: sellOnlyWebhookId, eventType: 'SELL' },
    });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].eventType).toBe('SELL');
  });
});

describe('Webhook event type filter — cross-isolation', () => {
  it('buy-only webhook and sell-only webhook co-exist — each receives only their event', async () => {
    const buyWh = await prisma.webhook.create({
      data: { creatorId, callbackUrl: 'https://example.com/buy', events: { set: ['BUY'] } },
    });
    const sellWh = await prisma.webhook.create({
      data: { creatorId, callbackUrl: 'https://example.com/sell', events: { set: ['SELL'] } },
    });

    const { dispatchWebhookEvent } = await import('./webhook.service');

    // Fire a buy
    await dispatchWebhookEvent({ ...BASE_TRADE, type: 'buy' });

    const buyEvents = await prisma.webhookEvent.findMany({ where: { webhookId: buyWh.id } });
    const sellEventsOnBuyFire = await prisma.webhookEvent.findMany({ where: { webhookId: sellWh.id } });

    expect(buyEvents.length).toBeGreaterThan(0);
    expect(sellEventsOnBuyFire).toHaveLength(0);

    // Fire a sell
    await dispatchWebhookEvent({ ...BASE_TRADE, type: 'sell' });

    const sellEvents = await prisma.webhookEvent.findMany({ where: { webhookId: sellWh.id } });
    const buyEventsOnSellFire = await prisma.webhookEvent.findMany({
      where: { webhookId: buyWh.id, eventType: 'SELL' },
    });

    expect(sellEvents.length).toBeGreaterThan(0);
    expect(buyEventsOnSellFire).toHaveLength(0);

    // cleanup
    await prisma.webhookEvent.deleteMany({ where: { webhookId: { in: [buyWh.id, sellWh.id] } } });
    await prisma.webhook.deleteMany({ where: { id: { in: [buyWh.id, sellWh.id] } } });
  });
});
