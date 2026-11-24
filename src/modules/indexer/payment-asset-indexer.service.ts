// src/modules/indexer/payment-asset-indexer.service.ts
// Syncs PaymentAsset registry rows from on-chain contract events (#1309).

import { prisma } from '../../utils/prisma.utils';
import { logger } from '../../utils/logger.utils';
import {
   IndexerChainEvent,
   processIndexerChainEvents,
} from '../../utils/indexer-event-processor.utils';
import { quoteService } from '../payments/quote.service';

export const PAYMENT_ASSET_EVENT_TYPES = new Set([
   'PAYMENT_ASSET_ADDED',
   'PaymentAssetAdded',
   'payment_asset_added',
   'PAYMENT_ASSET_UPDATED',
   'PaymentAssetUpdated',
   'payment_asset_updated',
   'PAYMENT_ASSET_ENABLED',
   'PaymentAssetEnabled',
   'payment_asset_enabled',
   'PAYMENT_ASSET_DISABLED',
   'PaymentAssetDisabled',
   'payment_asset_disabled',
   'PAYMENT_ASSET_RATE_UPDATED',
   'PaymentAssetRateUpdated',
   'payment_asset_rate_updated',
]);

export function isPaymentAssetEvent(event: IndexerChainEvent): boolean {
   return PAYMENT_ASSET_EVENT_TYPES.has(event.eventType);
}

export async function processPaymentAssetEvents(
   events: IndexerChainEvent[]
): Promise<void> {
   await processIndexerChainEvents(events, async event => {
      if (!isPaymentAssetEvent(event)) return;

      const raw = event as Record<string, unknown>;
      const token =
         typeof raw.token === 'string' && raw.token.trim().length > 0
            ? raw.token.trim()
            : null;

      if (!token) {
         logger.warn(
            { eventType: event.eventType, txHash: event.txHash },
            'Skipping payment asset event without token'
         );
         return;
      }

      const typeLower = event.eventType.toLowerCase();

      if (typeLower.includes('disabled')) {
         await prisma.paymentAsset.updateMany({
            where: { token },
            data: { enabled: false },
         });
         await quoteService.invalidateRateCache(token);
         return;
      }

      if (typeLower.includes('enabled')) {
         await prisma.paymentAsset.updateMany({
            where: { token },
            data: { enabled: true },
         });
         await quoteService.invalidateRateCache(token);
         return;
      }

      if (typeLower.includes('rate_updated') || typeLower.includes('rateupdated')) {
         const rateRaw = raw.rate7 ?? raw.rate;
         if (rateRaw !== undefined && rateRaw !== null) {
            const rate7 = BigInt(String(rateRaw));
            const updatedAt = raw.updatedAt
               ? new Date(String(raw.updatedAt))
               : new Date();
            await prisma.paymentAsset.updateMany({
               where: { token },
               data: { rate7, rateUpdatedAt: updatedAt },
            });
            await quoteService.invalidateRateCache(token);
         }
         return;
      }

      const symbol =
         typeof raw.symbol === 'string' && raw.symbol.trim().length > 0
            ? raw.symbol.trim()
            : token;
      const decimals =
         typeof raw.decimals === 'number' && Number.isInteger(raw.decimals)
            ? raw.decimals
            : 7;
      const oracle =
         typeof raw.oracle === 'string' && raw.oracle.trim().length > 0
            ? raw.oracle.trim()
            : null;
      const enabled =
         typeof raw.enabled === 'boolean' ? raw.enabled : true;
      const rate7 =
         raw.rate7 !== undefined && raw.rate7 !== null
            ? BigInt(String(raw.rate7))
            : undefined;
      const rateUpdatedAt =
         rate7 !== undefined
            ? raw.updatedAt
               ? new Date(String(raw.updatedAt))
               : new Date()
            : undefined;

      await prisma.paymentAsset.upsert({
         where: { token },
         create: {
            token,
            symbol,
            decimals,
            oracle,
            enabled,
            ...(rate7 !== undefined ? { rate7, rateUpdatedAt } : {}),
         },
         update: {
            symbol,
            decimals,
            oracle,
            enabled,
            ...(rate7 !== undefined ? { rate7, rateUpdatedAt } : {}),
         },
      });

      await quoteService.invalidateRateCache(token);
   });
}
