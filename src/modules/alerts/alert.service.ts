import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';
import { logger } from '../../utils/logger.utils';
import { CreateAlertInput } from './alert.schemas';

export type PriceMovement = {
    creatorId: string;
    previousPrice: number | string;
    currentPrice: number | string;
};

/**
 * Creates a new price alert for a wallet address watching a creator's key price.
 */
export async function createAlert(input: CreateAlertInput) {
    const alert = await prisma.priceAlert.create({
        data: {
            creatorId: input.creator_id,
            walletAddress: input.wallet_address,
            targetPrice: input.target_price,
            direction: input.direction,
            callbackUrl: input.callback_url,
        },
    });

    logger.info(
        {
            alert_id: alert.id,
            creator_id: alert.creatorId,
            direction: alert.direction,
            target_price: toNumber(alert.targetPrice),
            registered_at: alert.createdAt,
            wallet_address: maskWalletAddress(alert.walletAddress),
        },
        'Price alert registered'
    );

    return alert;
}

/**
 * Lists all active price alerts for a given wallet address.
 */
export async function listAlerts(walletAddress: string) {
    return await prisma.priceAlert.findMany({
        where: { walletAddress, isActive: true },
        orderBy: { createdAt: 'desc' },
    });
}

/**
 * Deletes a price alert by id, scoped to the wallet address for authorization.
 * Returns the deleted record id or null if not found.
 */
export async function deleteAlert(
    id: string,
    walletAddress: string
): Promise<{ id: string } | null> {
    const existing = await prisma.priceAlert.findFirst({
        where: { id, walletAddress },
    });

    if (!existing) {
        return null;
    }

    await prisma.priceAlert.delete({ where: { id } });

    logger.info(
        {
            alert_id: existing.id,
            creator_id: existing.creatorId,
            cancelled_at: new Date(),
            wallet_address: maskWalletAddress(existing.walletAddress),
        },
        'Price alert cancelled'
    );

    return { id };
}

function toNumber(value: number | string | { toString(): string }): number {
    return typeof value === 'number' ? value : Number(value.toString());
}

function maskWalletAddress(address: string): string {
    if (address.length <= 8) return address;
    return `${address.slice(0, 4)}***${address.slice(-4)}`;
}

function maskCallbackUrl(callbackUrl: string): string {
    try {
        const url = new URL(callbackUrl);
        return `${url.protocol}//${url.host}`;
    } catch {
        return 'invalid-url';
    }
}

function getDeliveryErrorCode(error: unknown): string {
    if (error instanceof Error && error.message.startsWith('HTTP_')) {
        return error.message;
    }

    return error instanceof Error ? error.name : 'UNKNOWN_ERROR';
}

async function deliverPriceAlertWebhook(
    alert: {
        id: string;
        creatorId: string;
        walletAddress: string;
        targetPrice: unknown;
        direction: string;
        callbackUrl: string;
    },
    payload: Record<string, unknown>
): Promise<void> {
    const maxAttempts = envConfig.WEBHOOK_RETRY_MAX_ATTEMPTS;
    const maskedUrl = maskCallbackUrl(alert.callbackUrl);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const response = await fetch(alert.callbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });

            if (!response.ok) {
                throw new Error(`HTTP_${response.status}`);
            }

            return;
        } catch (error) {
            const logFields = {
                alert_id: alert.id,
                retry_count: attempt,
                error_code: getDeliveryErrorCode(error),
                failure_reason: error instanceof Error ? error.message : 'Unknown error',
                masked_url: maskedUrl,
            };

            if (attempt === maxAttempts) {
                logger.error(
                    { ...logFields, final: true },
                    'Price alert webhook delivery exhausted retries'
                );
                throw error;
            }

            logger.warn(logFields, 'Price alert webhook delivery failed');
        }
    }
}

/**
 * Evaluates active alerts for a creator price movement and delivers only alerts
 * whose threshold was crossed in the registered direction.
 */
export async function evaluatePriceAlertsForMovement(
    movement: PriceMovement
): Promise<void> {
    const previousPrice = toNumber(movement.previousPrice);
    const currentPrice = toNumber(movement.currentPrice);

    const alerts = await prisma.priceAlert.findMany({
        where: {
            creatorId: movement.creatorId,
            isActive: true,
            triggeredAt: null,
        },
    });

    for (const alert of alerts) {
        const targetPrice = toNumber(alert.targetPrice);
        const crossedAbove =
            alert.direction === 'above' &&
            previousPrice < targetPrice &&
            currentPrice >= targetPrice;
        const crossedBelow =
            alert.direction === 'below' &&
            previousPrice > targetPrice &&
            currentPrice <= targetPrice;

        if (!crossedAbove && !crossedBelow) {
            continue;
        }

        await deliverPriceAlertWebhook(alert, {
            event_type: 'price_alert',
            alert_id: alert.id,
            creator_id: alert.creatorId,
            wallet_address: alert.walletAddress,
            target_price: targetPrice,
            current_price: currentPrice,
            direction: alert.direction,
        });

        await prisma.priceAlert.update({
            where: { id: alert.id },
            data: {
                isActive: false,
                triggeredAt: new Date(),
            },
        });
    }
}
