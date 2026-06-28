import type { Response } from 'express';
import {
  registerWebhookHandler,
  listWebhooksHandler,
  deleteWebhookHandler,
} from './webhook.controllers';
import * as webhookService from './webhook.service';

jest.mock('./webhook.service');

const mockService = webhookService as jest.Mocked<typeof webhookService>;

function createMockSignedRequest(creatorId = 'creator-1', params: Record<string, string> = {}) {
  return {
    body: {},
    params: { id: creatorId, ...params },
    creatorId,
    method: 'POST',
    originalUrl: `/api/v1/creators/${creatorId}/webhooks`,
  } as any;
}

function createMockResponse() {
  const res: Partial<Response> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn().mockReturnValue(res);
  res.end = jest.fn().mockReturnValue(res);
  return res as Response;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('registerWebhookHandler', () => {
  it('returns 400 for invalid body', async () => {
    const req = createMockSignedRequest();
    req.body = { callback_url: 'not-a-url', events: [] };
    const res = createMockResponse();

    await registerWebhookHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 201 on success', async () => {
    mockService.createWebhook.mockResolvedValue({
      id: 'wh-1',
      creatorId: 'creator-1',
      callbackUrl: 'https://example.com/hook',
      events: ['buy', 'sell'],
      isActive: true,
      isFailing: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const req = createMockSignedRequest();
    req.body = { callback_url: 'https://example.com/hook', events: ['buy', 'sell'] };
    const res = createMockResponse();

    await registerWebhookHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(mockService.createWebhook).toHaveBeenCalledWith('creator-1', {
      callbackUrl: 'https://example.com/hook',
      events: ['buy', 'sell'],
    });
  });

  it('returns 409 when max webhooks reached', async () => {
    mockService.createWebhook.mockRejectedValue(
      Object.assign(new Error('Max webhooks reached'), { statusCode: 409, code: 'MAX_WEBHOOKS_REACHED' })
    );

    const req = createMockSignedRequest();
    req.body = { callback_url: 'https://example.com/hook', events: ['buy'] };
    const res = createMockResponse();

    await registerWebhookHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
  });
});

describe('listWebhooksHandler', () => {
  it('returns 200 with webhooks list', async () => {
    mockService.listWebhooks.mockResolvedValue([
      {
        id: 'wh-1',
        creatorId: 'creator-1',
        callbackUrl: 'https://example.com/hook',
        events: ['buy'],
        isActive: true,
        isFailing: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const req = createMockSignedRequest();
    const res = createMockResponse();

    await listWebhooksHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockService.listWebhooks).toHaveBeenCalledWith('creator-1');
  });
});

describe('deleteWebhookHandler', () => {
  it('returns 404 for non-existent webhook', async () => {
    mockService.deleteWebhook.mockResolvedValue(null);

    const req = createMockSignedRequest('creator-1', { webhookId: 'wh-nonexistent' });
    const res = createMockResponse();

    await deleteWebhookHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns 204 on successful deletion', async () => {
    mockService.deleteWebhook.mockResolvedValue({ id: 'wh-1' });

    const req = createMockSignedRequest('creator-1', { webhookId: 'wh-1' });
    const res = createMockResponse();

    await deleteWebhookHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(204);
    expect(mockService.deleteWebhook).toHaveBeenCalledWith('wh-1', 'creator-1');
  });
});
