import { prisma } from '../../utils/prisma.utils';
import { envConfig } from '../../config';
import { logger } from '../../utils/logger.utils';
import { CreateAlertInput } from './alert.schemas';
import { truncateWallet } from '../../utils/wallet-display.utils';

export type PriceMovement = {
   creatorId: string;
   previousPrice: number | string;
   currentPrice: number | string;
   ledger_sequence?: number;
};

/**
 * Creates a new price alert for a wallet address watching a creator's key price.
 * Throws a 409 error if an identical active alert already exists.
 */
export async function createAlert(input: CreateAlertInput) {
   // Check for duplicate active alert
   const existingAlert = await prisma.priceAlert.findFirst({
      where: {
         creatorId: input.creator_id,
         walletAddress: input.wallet_address,
         targetPrice: input.target_price,
         direction: input.direction,
         isActive: true,
      },
   });

   if (existingAlert) {
      const error = new Error(
         'An identical active alert already exists for this creator, wallet, price, and direction'
      ) as any;
      error.statusCode = 409;
      error.code = 'DUPLICATE_ALERT';
      throw error;
   }

   const alert = await prisma.priceAlert.create({
      data: {
         creatorId: input.creator_id,
         walletAddress: input.wallet_address,
         targetPrice: input.target_price,
         direction: input.direction,
         callbackUrl: input.callback_url ?? null,
      },
   });

   logger.info(
      {
         alert_id: alert.id,
         creator_id: alert.creatorId,
         direction: alert.direction,
         target_price: toNumber(alert.targetPrice),
         registered_at: alert.createdAt,
         wallet_address: truncateWallet(alert.walletAddress),
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
 * Issue #1012: returns every triggered (not-necessarily-active) alert for a
 * wallet so the notifications service can surface them in-app. Ordered by
 * triggeredAt desc so newest fires first.
 */
export async function listTriggeredAlertsForWallet(walletAddress: string) {
   return await prisma.priceAlert.findMany({
      where: {
         walletAddress,
         triggeredAt: { not: null },
      },
      orderBy: { triggeredAt: 'desc' },
   });
}

/**
 * Deletes a price alert by id, scoped to the wallet address for authorization.
 * Returns the deleted record id or null if not found.
 * Throws 403 if the alert belongs to a different wallet.
 */
export async function deleteAlert(
   id: string,
   walletAddress?: string
): Promise<{ id: string } | null> {
   const existing = await prisma.priceAlert.findFirst({
      where: { id },
   });

   if (!existing) {
      return null;
   }

   if (walletAddress && existing.walletAddress !== walletAddress) {
      const error = new Error(
         'You do not have permission to delete this alert'
      ) as any;
      error.statusCode = 403;
      error.code = 'FORBIDDEN';
      throw error;
   }

   await prisma.priceAlert.delete({ where: { id } });

   logger.info(
      {
         alert_id: existing.id,
         creator_id: existing.creatorId,
         cancelled_at: new Date(),
         wallet_address: truncateWallet(existing.walletAddress),
      },
      'Price alert cancelled'
   );

   return { id };
}

/**
 * Manually marks a price alert as triggered (inactive, with triggeredAt timestamp).
 * Scoped to the wallet address for authorization.
 * Returns the updated record or null if not found.
 * Throws 403 if the alert belongs to a different wallet.
 */
export async function triggerAlert(
   id: string,
   walletAddress?: string
) {
   const existing = await prisma.priceAlert.findFirst({
      where: { id },
   });

   if (!existing) {
      return null;
   }

   if (walletAddress && existing.walletAddress !== walletAddress) {
      const error = new Error(
         'You do not have permission to modify this alert'
      ) as any;
      error.statusCode = 403;
      error.code = 'FORBIDDEN';
      throw error;
   }

   const updated = await prisma.priceAlert.update({
      where: { id },
      data: {
         isActive: false,
         triggeredAt: new Date(),
      },
   });

   logger.info(
      {
         alert_id: updated.id,
         creator_id: updated.creatorId,
         triggered_at: updated.triggeredAt,
         wallet_address: truncateWallet(updated.walletAddress),
      },
      'Price alert triggered'
   );

   return updated;
}

function toNumber(value: number | string | { toString(): string }): number {
   return typeof value === 'number' ? value : Number(value.toString());
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
      callbackUrl: string | null;
   },
   payload: Record<string, unknown>
): Promise<void> {
   if (!alert.callbackUrl) {
      return;
   }

   const maxAttempts = envConfig.WEBHOOK_RETRY_MAX_ATTEMPTS;
   const maskedUrl = maskCallbackUrl(alert.callbackUrl);
   const threshold = toNumber(alert.targetPrice as string | number | { toString(): string});
   const triggeredPrice = toNumber(payload.current_price as string | number | { toString(): string });

   for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptedAt = new Date();
      try {
         const response = await fetch(alert.callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
         });

         if (!response.ok) {
            throw new Error(`HTTP_${response.status}`);
         }

         logger.debug(
            {
               alert_id: alert.id,
               creator_id: alert.creatorId,
               threshold,
               triggered_price: triggeredPrice,
               delivery_status: 'success',
               attempted_at: attemptedAt,
            },
            'Price alert delivery attempt completed'
         );

         return;
      } catch (error) {
         const logFields = {
            alert_id: alert.id,
            retry_count: attempt,
            error_code: getDeliveryErrorCode(error),
            failure_reason:
               error instanceof Error ? error.message : 'Unknown error',
            masked_url: maskedUrl,
         };

         logger.debug(
            {
               alert_id: alert.id,
               creator_id: alert.creatorId,
               threshold,
               triggered_price: triggeredPrice,
               delivery_status: 'failed',
               attempted_at: attemptedAt,
            },
            'Price alert delivery attempt completed'
         );

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
 *
 * Issue #1012: alert disable is unconditional — even if webhook delivery
 * throws, the alert is disabled and (via listTriggeredAlertsForWallet) becomes
 * visible in the in-app notification feed. Webhook failure is logged, not
 * propagated, so callers wiring this into the price pipeline can't roll back
 * a trade.
 */
export async function evaluatePriceAlertsForMovement(
   movement: PriceMovement
): Promise<void> {
   try {
      const previousPrice = toNumber(movement.previousPrice);
      const currentPrice = toNumber(movement.currentPrice);

      const alerts = await prisma.priceAlert.findMany({
         where: {
            creatorId: movement.creatorId,
            isActive: true,
            triggeredAt: null,
         },
      });

      let alertsTriggered = 0;

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

         // Disable + record trigger first — this is what the in-app
         // notification reads. If this succeeds, the user sees the alert even
         // if the webhook below fails.
         await prisma.priceAlert.update({
            where: { id: alert.id },
            data: {
               isActive: false,
               triggeredAt: new Date(),
            },
         });
         alertsTriggered += 1;

         try {
            await deliverPriceAlertWebhook(alert, {
               event_type: 'price_alert',
               alert_id: alert.id,
               creator_id: alert.creatorId,
               wallet_address: alert.walletAddress,
               target_price: targetPrice,
               current_price: currentPrice,
               direction: alert.direction,
            });
         } catch (webhookError) {
            logger.error(
               {
                  alert_id: alert.id,
                  creator_id: alert.creatorId,
                  error_message:
                     webhookError instanceof Error
                        ? webhookError.message
                        : 'Unknown error',
               },
               'Price alert webhook failed after alert was disabled'
            );
         }
      }

      logger[alertsTriggered > 0 ? 'info' : 'debug'](
         {
            creator_id: movement.creatorId,
            alerts_evaluated: alerts.length,
            alerts_triggered: alertsTriggered,
            new_price: currentPrice,
            checked_at: new Date().toISOString(),
         },
         'Price alert check run'
      );
   } catch (err) {
      logger.error(
         {
            creator_id: movement.creatorId,
            ledger_sequence: movement.ledger_sequence,
            new_price: movement.currentPrice,
            error_message: err instanceof Error ? err.message : 'Unknown error',
            failed_at: new Date().toISOString(),
         },
         'Price alert threshold check failed'
      );
      throw err;
   }
}