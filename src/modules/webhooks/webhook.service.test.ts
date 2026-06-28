import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';
import * as webhookService from './webhook.service';
import { logger } from '../../utils/logger.utils';

jest.mock('../../utils/prisma.utils', () => ({
  prisma: {
    webhook: {
      count: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      delete: jest.fn(),
      update: jest.fn(),
    },
    webhookEvent: {
      create: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
  },
}));

jest.mock('../../utils/logger.utils', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockPrisma = prisma as unknown as {
  webhook: {
    count: jest.Mock;
    create: jest.Mock;
    findMany: jest.Mock;
    findFirst: jest.Mock;
    findUnique: jest.Mock;
    delete: jest.Mock;
    update: jest.Mock;
  };
  webhookEvent: {
    create: jest.Mock;
    findMany: jest.Mock;
    updateMany: jest.Mock;
  };
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('createWebhook', () => {
  it('creates a webhook when under the max limit', async () => {
    mockPrisma.webhook.count.mockResolvedValue(0);
    mockPrisma.webhook.create.mockResolvedValue({
      id: 'wh-1',
      creatorId: 'creator-1',
      callbackUrl: 'https://example.com/hook',
      events: ['BUY', 'SELL'],
      isActive: true,
      isFailing: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await webhookService.createWebhook('creator-1', {
      callbackUrl: 'https://example.com/hook',
      events: ['buy', 'sell'],
    });

    expect(result.events).toEqual(['buy', 'sell']);
    expect(result.callbackUrl).toBe('https://example.com/hook');
    expect(mockPrisma.webhook.count).toHaveBeenCalledWith({
      where: { creatorId: 'creator-1', isActive: true },
    });
  });

  it('rejects creation when max webhooks reached', async () => {
    mockPrisma.webhook.count.mockResolvedValue(envConfig.WEBHOOK_MAX_PER_CREATOR);

    await expect(
      webhookService.createWebhook('creator-1', {
        callbackUrl: 'https://example.com/hook',
        events: ['buy'],
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'MAX_WEBHOOKS_REACHED',
    });
  });
});

describe('listWebhooks', () => {
  it('returns denormalized event names', async () => {
    mockPrisma.webhook.findMany.mockResolvedValue([
      {
        id: 'wh-1',
        creatorId: 'creator-1',
        callbackUrl: 'https://example.com/hook',
        events: ['BUY'],
        isActive: true,
        isFailing: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const result = await webhookService.listWebhooks('creator-1');
    expect(result[0].events).toEqual(['buy']);
  });
});

describe('deleteWebhook', () => {
  it('deletes a webhook owned by the creator', async () => {
    mockPrisma.webhook.findFirst.mockResolvedValue({
      id: 'wh-1',
      creatorId: 'creator-1',
    });
    mockPrisma.webhook.delete.mockResolvedValue({ id: 'wh-1' });

    const result = await webhookService.deleteWebhook('wh-1', 'creator-1');
    expect(result).toEqual({ id: 'wh-1' });
    expect(mockPrisma.webhook.delete).toHaveBeenCalledWith({
      where: { id: 'wh-1' },
    });
  });

  it('returns null for non-existent webhook', async () => {
    mockPrisma.webhook.findFirst.mockResolvedValue(null);

    const result = await webhookService.deleteWebhook('wh-1', 'creator-1');
    expect(result).toBeNull();
  });
});

describe('dispatchWebhookEvent', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('does nothing when no matching webhooks', async () => {
    mockPrisma.webhook.findMany.mockResolvedValue([]);

    await webhookService.dispatchWebhookEvent({
      type: 'buy',
      creatorId: 'creator-1',
      buyerOrSellerAddress: 'G...',
      amount: '100',
      price: '10',
      feePaid: '0.5',
      timestamp: new Date().toISOString(),
    });

    expect(mockPrisma.webhook.findMany).toHaveBeenCalled();
    expect(mockPrisma.webhookEvent.create).not.toHaveBeenCalled();
  });

  it('creates WebhookEvent and dispatches for matching webhooks', async () => {
    mockPrisma.webhook.findMany.mockResolvedValue([
      {
        id: 'wh-1',
        creatorId: 'creator-1',
        callbackUrl: 'https://example.com/hook',
        events: ['BUY'],
        isActive: true,
        isFailing: false,
      },
    ]);
    mockPrisma.webhookEvent.create.mockResolvedValue({ id: 'we-1' });
    mockPrisma.webhookEvent.updateMany.mockResolvedValue({ count: 1 });

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    });
    (global.fetch as jest.Mock) = mockFetch;

    await webhookService.dispatchWebhookEvent({
      type: 'buy',
      creatorId: 'creator-1',
      buyerOrSellerAddress: 'G...',
      amount: '100',
      price: '10',
      feePaid: '0.5',
      timestamp: new Date().toISOString(),
    });

    expect(mockPrisma.webhookEvent.create).toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalled();
  });

  it('respects event type filter — buy webhook does not fire for sell events', async () => {
    mockPrisma.webhook.findMany.mockImplementation(
      (args: { where: { events: { has: string } } }) => {
        if (args?.where?.events?.has === 'BUY') {
          return Promise.resolve([
            {
              id: 'wh-buy',
              creatorId: 'creator-1',
              callbackUrl: 'https://example.com/hook-buy',
              events: ['BUY'],
              isActive: true,
              isFailing: false,
            },
          ]);
        }
        return Promise.resolve([]);
      }
    );

    await webhookService.dispatchWebhookEvent({
      type: 'sell',
      creatorId: 'creator-1',
      buyerOrSellerAddress: 'G...',
      amount: '50',
      price: '20',
      feePaid: '1.0',
      timestamp: new Date().toISOString(),
    });

    expect(mockPrisma.webhook.findMany).toHaveBeenCalled();
    expect(mockPrisma.webhookEvent.create).not.toHaveBeenCalled();
  });

  it('retries delivery up to max attempts and flags webhook as failing', async () => {
    mockPrisma.webhook.findMany.mockResolvedValue([
      {
        id: 'wh-1',
        creatorId: 'creator-1',
        callbackUrl: 'https://nonexistent.example.com/fail',
        events: ['SELL'],
        isActive: true,
        isFailing: false,
      },
    ]);
    mockPrisma.webhookEvent.create.mockResolvedValue({ id: 'we-1' });
    mockPrisma.webhookEvent.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.webhook.update.mockResolvedValue({});
    mockPrisma.webhook.findUnique.mockResolvedValue({
      callbackUrl: 'https://nonexistent.example.com/fail',
    });

    const mockFetch = jest.fn().mockRejectedValue(new Error('Network error'));
    (global.fetch as jest.Mock) = mockFetch;

    const dispatchPromise = webhookService.dispatchWebhookEvent({
      type: 'sell',
      creatorId: 'creator-1',
      buyerOrSellerAddress: 'G...',
      amount: '10',
      price: '5',
      feePaid: '0.25',
      timestamp: new Date().toISOString(),
    });

    for (let i = 0; i < envConfig.WEBHOOK_RETRY_MAX_ATTEMPTS; i++) {
      await jest.advanceTimersByTimeAsync(Math.pow(2, i + 1) * 1000);
    }

    await dispatchPromise;

    expect(mockFetch).toHaveBeenCalledTimes(envConfig.WEBHOOK_RETRY_MAX_ATTEMPTS);
    expect(mockPrisma.webhook.update).toHaveBeenCalledWith({
      where: { id: 'wh-1' },
      data: { isFailing: true },
    });
    expect(mockPrisma.webhookEvent.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }),
      })
    );

    expect(logger.warn).toHaveBeenCalledTimes(envConfig.WEBHOOK_RETRY_MAX_ATTEMPTS - 1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        webhook_id: 'wh-1',
        creator_id: 'creator-1',
        attempt_number: 2,
        backoff_delay_ms: 2000,
        last_error_code: 'Network error',
      }),
      'Webhook delivery failed, retrying'
    );
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        webhook_id: 'wh-1',
        creator_id: 'creator-1',
        attempt_number: envConfig.WEBHOOK_RETRY_MAX_ATTEMPTS,
        last_error_code: 'Network error',
      }),
      'Webhook delivery exhausted all retries, flagged as failing'
    );
  });
});
