import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { envConfig } from '../../config';
import { maskWebhookUrl } from '../../utils/webhook-mask.utils';
import { buildWebhookPayload } from './webhook-payload.utils';
import type { CreateWebhookInput, TradeEvent, WebhookEventPayload, WebhookEventName } from './webhook.types';

function normalizeEvents(events: string[]): ('BUY' | 'SELL')[] {
  return events.map((e) => (e === 'buy' ? 'BUY' : 'SELL'));
}

function denormalizeEvents(events: ('BUY' | 'SELL')[]): WebhookEventName[] {
  return events.map((e) => (e === 'BUY' ? 'buy' : 'sell'));
}

export async function createWebhook(
  creatorId: string,
  input: CreateWebhookInput
) {
  const count = await prisma.webhook.count({
    where: { creatorId, isActive: true },
  });

  if (count >= envConfig.WEBHOOK_MAX_PER_CREATOR) {
    throw Object.assign(
      new Error(
        `Maximum of ${envConfig.WEBHOOK_MAX_PER_CREATOR} active webhooks per creator reached`
      ),
      { statusCode: 422, code: 'MAX_WEBHOOKS_REACHED' }
    );
  }

  const webhook = await prisma.webhook.create({
    data: {
      creatorId,
      callbackUrl: input.callbackUrl,
      events: {
        set: normalizeEvents(input.events),
      },
    },
  });

  logger.info(
    { creator_id: creatorId, webhook_id: webhook.id, event_types: input.events, registered_at: webhook.createdAt.toISOString() },
    'Webhook registered'
  );

  return {
    ...webhook,
    events: denormalizeEvents(webhook.events as ('BUY' | 'SELL')[]),
  };
}

export async function listWebhooks(creatorId: string) {
  const webhooks = await prisma.webhook.findMany({
    where: { creatorId },
    orderBy: { createdAt: 'desc' },
  });

  return webhooks.map((w) => ({
    ...w,
    events: denormalizeEvents(w.events as ('BUY' | 'SELL')[]),
  }));
}

export async function deleteWebhook(webhookId: string, creatorId: string) {
  const webhook = await prisma.webhook.findFirst({
    where: { id: webhookId, creatorId },
  });

  if (!webhook) {
    return null;
  }

  await prisma.webhook.delete({ where: { id: webhookId } });

  logger.info(
    { creator_id: creatorId, webhook_id: webhookId, deleted_at: new Date().toISOString() },
    'Webhook deleted'
  );

  return { id: webhookId };
}

export async function dispatchWebhookEvent(tradeEvent: TradeEvent) {
  const eventName: 'BUY' | 'SELL' =
    tradeEvent.type === 'buy' ? 'BUY' : 'SELL';

  const webhooks = await prisma.webhook.findMany({
    where: {
      creatorId: tradeEvent.creatorId,
      isActive: true,
      isFailing: false,
      events: { has: eventName },
    },
  });

  if (webhooks.length === 0) return;

  for (const webhook of webhooks) {
    const payload: WebhookEventPayload = buildWebhookPayload(tradeEvent);

    await prisma.webhookEvent.create({
      data: {
        webhookId: webhook.id,
        eventType: eventName,
        payload: payload as unknown as Record<string, unknown>,
        status: 'PENDING',
      },
    });

    attemptDelivery(webhook.id, webhook.callbackUrl, payload).catch((err) => {
      logger.error({ webhookId: webhook.id, error: err.message }, 'Webhook delivery failed');
    });
  }
}

async function attemptDelivery(
  webhookId: string,
  callbackUrl: string,
  payload: WebhookEventPayload,
  attempt = 1
): Promise<void> {
  const maxAttempts = envConfig.WEBHOOK_RETRY_MAX_ATTEMPTS;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const startTime = Date.now();

    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const endTime = Date.now();
    const responseTimeMs = endTime - startTime;
    clearTimeout(timeout);

    if (response.ok) {
      await prisma.webhookEvent.updateMany({
        where: { webhookId, status: 'PENDING' },
        data: { status: 'DELIVERED', retryCount: attempt },
      });

      logger.info(
        {
          webhook_id: webhookId,
          creator_id: payload.creator_id,
          event_type: payload.event_type,
          response_status: response.status,
          response_time_ms: responseTimeMs,
          delivered_at: new Date().toISOString(),
        },
        'Webhook delivery succeeded'
      );
      return;
    }

    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';

    await prisma.webhookEvent.updateMany({
      where: { webhookId, status: 'PENDING' },
      data: { retryCount: attempt, lastError: errMsg },
    });

    if (attempt < maxAttempts) {
      const delay = Math.pow(2, attempt) * 1000;
      logger.warn(
        {
          webhook_id: webhookId,
          creator_id: payload.creator_id,
          callback_url: maskWebhookUrl(callbackUrl),
          attempt_number: attempt + 1,
          backoff_delay_ms: delay,
          last_error_code: errMsg,
        },
        'Webhook delivery failed, retrying'
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      return attemptDelivery(webhookId, callbackUrl, payload, attempt + 1);
    }

    await prisma.webhook.update({
      where: { id: webhookId },
      data: { isFailing: true },
    });

    await prisma.webhookEvent.updateMany({
      where: { webhookId, status: 'PENDING' },
      data: { status: 'FAILED', retryCount: attempt },
    });

    logger.error(
      {
        webhook_id: webhookId,
        creator_id: payload.creator_id,
        attempt_number: attempt,
        last_error_code: errMsg,
      },
      'Webhook delivery exhausted all retries, flagged as failing'
    );
  }
}
