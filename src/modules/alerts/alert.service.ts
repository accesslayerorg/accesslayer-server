import { Prisma } from '@prisma/client';
import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import { envConfig } from '../../config';
import type {
  AlertDirectionName,
  AlertResponse,
  AlertTradeEvent,
  AlertTriggerPayload,
  CreateAlertInput,
} from './alert.types';

type DbDirection = 'ABOVE' | 'BELOW';
type DbStatus = 'PENDING' | 'TRIGGERED' | 'FAILED';

function toDbDirection(direction: AlertDirectionName): DbDirection {
  return direction === 'above' ? 'ABOVE' : 'BELOW';
}

function fromDbDirection(direction: DbDirection): AlertDirectionName {
  return direction === 'ABOVE' ? 'above' : 'below';
}

function fromDbStatus(status: DbStatus): AlertResponse['status'] {
  switch (status) {
    case 'TRIGGERED':
      return 'triggered';
    case 'FAILED':
      return 'failed';
    default:
      return 'pending';
  }
}

interface AlertRecord {
  id: string;
  creatorId: string;
  walletAddress: string;
  targetPrice: Prisma.Decimal;
  direction: DbDirection;
  callbackUrl: string;
  status: DbStatus;
  createdAt: Date;
}

function toAlertResponse(alert: AlertRecord): AlertResponse {
  return {
    id: alert.id,
    creatorId: alert.creatorId,
    walletAddress: alert.walletAddress,
    targetPrice: alert.targetPrice.toString(),
    direction: fromDbDirection(alert.direction),
    callbackUrl: alert.callbackUrl,
    status: fromDbStatus(alert.status),
    createdAt: alert.createdAt,
  };
}

/**
 * Registers a one-shot price alert and returns its unique ID.
 */
export async function createAlert(
  input: CreateAlertInput
): Promise<AlertResponse> {
  const alert = await prisma.alert.create({
    data: {
      creatorId: input.creatorId,
      walletAddress: input.walletAddress,
      targetPrice: new Prisma.Decimal(input.targetPrice),
      direction: toDbDirection(input.direction),
      callbackUrl: input.callbackUrl,
    },
  });

  return toAlertResponse(alert as AlertRecord);
}

/**
 * Cancels a pending alert. Only alerts that have not already fired (PENDING)
 * can be cancelled. Returns the deleted alert ID, or null when not found.
 */
export async function deleteAlert(alertId: string): Promise<{ id: string } | null> {
  const alert = await prisma.alert.findFirst({
    where: { id: alertId, status: 'PENDING' },
  });

  if (!alert) {
    return null;
  }

  await prisma.alert.delete({ where: { id: alertId } });
  return { id: alertId };
}

/**
 * Returns true when the new price has crossed the registered threshold in the
 * direction the alert was registered for.
 *
 * - `above`: fires when the new price is at or above the target.
 * - `below`: fires when the new price is at or below the target.
 */
function crossesThreshold(
  direction: DbDirection,
  newPrice: number,
  targetPrice: number
): boolean {
  if (direction === 'ABOVE') {
    return newPrice >= targetPrice;
  }
  return newPrice <= targetPrice;
}

/**
 * Evaluates all pending alerts for the creator against the new trade price and
 * fires any whose threshold was crossed.
 *
 * Wire this into the indexer trade-event processing path alongside webhook
 * dispatch — it processes the same trade event.
 */
export async function evaluateTradeForAlerts(
  tradeEvent: AlertTradeEvent
): Promise<void> {
  const newPrice = Number(tradeEvent.price);
  if (!Number.isFinite(newPrice)) {
    logger.warn(
      { creatorId: tradeEvent.creatorId, price: tradeEvent.price },
      'Skipping alert evaluation: trade price is not a finite number'
    );
    return;
  }

  const alerts = await prisma.alert.findMany({
    where: {
      creatorId: tradeEvent.creatorId,
      status: 'PENDING',
    },
  });

  if (alerts.length === 0) return;

  for (const alert of alerts) {
    const targetPrice = Number((alert.targetPrice as Prisma.Decimal).toString());
    if (!crossesThreshold(alert.direction as DbDirection, newPrice, targetPrice)) {
      continue;
    }

    const payload: AlertTriggerPayload = {
      creator_id: alert.creatorId,
      triggered_price: tradeEvent.price,
      target_price: (alert.targetPrice as Prisma.Decimal).toString(),
      direction: fromDbDirection(alert.direction as DbDirection),
      timestamp: tradeEvent.timestamp,
    };

    await deliverAlert(alert.id, alert.callbackUrl, payload).catch((err) => {
      logger.error(
        { alertId: alert.id, error: err instanceof Error ? err.message : String(err) },
        'Alert delivery failed unexpectedly'
      );
    });
  }
}

/**
 * Delivers a triggered alert to its callback URL via HTTP POST.
 *
 * On success the alert is deleted (one-shot). On failure the delivery is retried
 * up to `WEBHOOK_RETRY_MAX_ATTEMPTS` times with exponential backoff (with
 * jitter); after the final failure the alert is marked FAILED.
 */
async function deliverAlert(
  alertId: string,
  callbackUrl: string,
  payload: AlertTriggerPayload,
  attempt = 1
): Promise<void> {
  const maxAttempts = envConfig.WEBHOOK_RETRY_MAX_ATTEMPTS;
  const baseDelayMs = envConfig.WEBHOOK_RETRY_BASE_DELAY_MS;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(callbackUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // One-shot: a successfully delivered alert is removed.
    await prisma.alert.delete({ where: { id: alertId } });
    logger.info({ alertId, attempt }, 'Alert delivered and deleted');
    return;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';

    await prisma.alert.update({
      where: { id: alertId },
      data: { retryCount: attempt, lastError: errMsg },
    });

    if (attempt < maxAttempts) {
      const delay = Math.pow(2, attempt - 1) * baseDelayMs;
      logger.warn(
        { alertId, attempt, maxAttempts, nextRetryMs: delay, error: errMsg },
        'Alert delivery failed, retrying'
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      return deliverAlert(alertId, callbackUrl, payload, attempt + 1);
    }

    await prisma.alert.update({
      where: { id: alertId },
      data: { status: 'FAILED', retryCount: attempt, triggeredAt: new Date() },
    });

    logger.error(
      { alertId, attempt, maxAttempts, error: errMsg },
      'Alert delivery exhausted all retries, marked failed'
    );
  }
}
