// src/modules/invoice/invoice-early-incentive.service.ts
// Early funding incentive slot status for an invoice (#1180).
//
// slots_filled is the number of indexed EarlySlotFilled events for the
// invoice, capped at slots_total. The incentive configuration (slots_total,
// bonus_bps) is taken from the most recent event, so the status reflects the
// latest on-chain configuration.

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheInvalidate, cacheSetJson } from '../../utils/redis.utils';

export const EARLY_INCENTIVE_CACHE_TTL_SECONDS = 30;

export interface EarlyIncentiveStatus {
   invoice_id: string;
   slots_total: number;
   slots_filled: number;
   slots_remaining: number;
   bonus_bps: number;
   is_active: boolean;
}

export function earlyIncentiveCacheKey(invoiceId: string): string {
   return `invoice:early-incentive:${invoiceId}`;
}

export async function invalidateEarlyIncentiveCache(
   invoiceId: string
): Promise<void> {
   await cacheInvalidate(earlyIncentiveCacheKey(invoiceId));
}

/** Derives the public status from the filled count and latest configuration. */
export function buildEarlyIncentiveStatus(input: {
   invoiceId: string;
   slotsTotal: number;
   bonusBps: number;
   slotsFilledEvents: number;
}): EarlyIncentiveStatus {
   const slotsFilled = Math.min(input.slotsFilledEvents, input.slotsTotal);
   const slotsRemaining = Math.max(input.slotsTotal - slotsFilled, 0);
   return {
      invoice_id: input.invoiceId,
      slots_total: input.slotsTotal,
      slots_filled: slotsFilled,
      slots_remaining: slotsRemaining,
      bonus_bps: input.bonusBps,
      is_active: input.slotsTotal > 0 && slotsRemaining > 0,
   };
}

/**
 * Returns the incentive status, or null when the invoice does not exist. An
 * existing invoice with no configured incentive reports is_active: false.
 */
export async function getEarlyIncentiveStatus(
   invoiceId: string
): Promise<EarlyIncentiveStatus | null> {
   const cacheKey = earlyIncentiveCacheKey(invoiceId);
   const cached = await cacheGetJson<EarlyIncentiveStatus>(cacheKey);
   if (cached) return cached;

   const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { id: true },
   });
   if (!invoice) return null;

   const [latest, slotsFilledEvents] = await Promise.all([
      prisma.invoiceEarlySlotEvent.findFirst({
         where: { invoiceId },
         orderBy: [{ ledger: 'desc' }, { eventIndex: 'desc' }],
      }),
      prisma.invoiceEarlySlotEvent.count({ where: { invoiceId } }),
   ]);

   const status = buildEarlyIncentiveStatus({
      invoiceId,
      slotsTotal: latest?.slotsTotal ?? 0,
      bonusBps: latest?.bonusBps ?? 0,
      slotsFilledEvents,
   });
   await cacheSetJson(cacheKey, status, EARLY_INCENTIVE_CACHE_TTL_SECONDS);
   return status;
}
