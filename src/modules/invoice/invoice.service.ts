// src/modules/invoice/invoice.service.ts
import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import {
   INVOICE_COMPARISON_CACHE_TTL_SECONDS,
   InvoiceComparison,
   InvoiceMetrics,
   SellerStats,
} from './invoice.schemas';

/** Raised when one or more requested invoice IDs do not resolve. */
export class InvoiceNotFoundError extends Error {
   readonly missingIds: string[];

   constructor(missingIds: string[]) {
      super(
         missingIds.length === 1
            ? `Invoice '${missingIds[0]}' not found`
            : `Invoices not found: ${missingIds.join(', ')}`
      );
      this.name = 'InvoiceNotFoundError';
      this.missingIds = missingIds;
   }
}

/**
 * Cache key for a comparison response. Sorted before joining so the key is
 * independent of the order the IDs were requested in (#947).
 */
export function invoiceComparisonCacheKey(ids: string[]): string {
   return `invoice:compare:${[...ids].sort().join(',')}`;
}

function decimalToString(
   value: { toString(): string } | null | undefined
): string {
   return value === null || value === undefined ? '0' : value.toString();
}

/**
 * Aggregates per-seller statistics for the sellers owning the compared
 * invoices. One `groupBy` covers every requested seller.
 */
async function fetchSellerStats(
   sellerWallets: string[]
): Promise<Map<string, SellerStats>> {
   if (sellerWallets.length === 0) return new Map();

   const groups = await prisma.invoice.groupBy({
      by: ['sellerWallet'],
      where: { sellerWallet: { in: sellerWallets } },
      _count: { _all: true },
      _sum: { amount: true },
      _avg: { rate: true },
   });

   return new Map(
      groups.map(group => [
         group.sellerWallet,
         {
            wallet: group.sellerWallet,
            invoice_count: group._count._all,
            total_amount: decimalToString(group._sum.amount),
            average_rate:
               group._avg.rate === null || group._avg.rate === undefined
                  ? null
                  : group._avg.rate.toString(),
         } as SellerStats,
      ])
   );
}

/**
 * Builds the metrics payload for the given invoices, throwing
 * {@link InvoiceNotFoundError} if any requested ID does not resolve.
 */
export async function fetchInvoiceComparison(
   ids: string[]
): Promise<InvoiceComparison> {
   const invoices = await prisma.invoice.findMany({
      where: { id: { in: ids } },
      select: {
         id: true,
         sellerWallet: true,
         currency: true,
         status: true,
         amount: true,
         rate: true,
         maturityDate: true,
         riskRating: true,
         fundingProgress: true,
      },
   });

   const found = new Map(invoices.map(invoice => [invoice.id, invoice]));
   const missing = ids.filter(id => !found.has(id));
   if (missing.length > 0) {
      throw new InvoiceNotFoundError(missing);
   }

   const sellerStats = await fetchSellerStats([
      ...new Set(invoices.map(invoice => invoice.sellerWallet)),
   ]);

   const metrics: Record<string, InvoiceMetrics> = {};
   for (const id of ids) {
      const invoice = found.get(id)!;
      metrics[id] = {
         invoice_id: invoice.id,
         seller_wallet: invoice.sellerWallet,
         currency: invoice.currency,
         status: invoice.status,
         amount: decimalToString(invoice.amount),
         rate: invoice.rate ? invoice.rate.toString() : null,
         maturity: invoice.maturityDate
            ? new Date(invoice.maturityDate).toISOString()
            : null,
         risk_rating: invoice.riskRating ?? null,
         funding_progress: decimalToString(invoice.fundingProgress),
         seller_stats: sellerStats.get(invoice.sellerWallet) ?? {
            wallet: invoice.sellerWallet,
            invoice_count: 0,
            total_amount: '0',
            average_rate: null,
         },
      };
   }

   return { invoice_ids: ids, invoices: metrics };
}

/**
 * Cache-backed wrapper around {@link fetchInvoiceComparison}. Repeated
 * requests for the same invoice combination are served from Redis for
 * {@link INVOICE_COMPARISON_CACHE_TTL_SECONDS} seconds (#947).
 */
export async function getInvoiceComparison(
   ids: string[]
): Promise<InvoiceComparison> {
   const cacheKey = invoiceComparisonCacheKey(ids);

   const cached = await cacheGetJson<InvoiceComparison>(cacheKey);
   if (cached) {
      // Cached payloads are keyed order-independently; restore the caller's
      // requested order before responding.
      return {
         invoice_ids: ids,
         invoices: ids.reduce<Record<string, InvoiceMetrics>>((acc, id) => {
            const metrics = cached.invoices?.[id];
            if (metrics) acc[id] = metrics;
            return acc;
         }, {}),
      };
   }

   const comparison = await fetchInvoiceComparison(ids);
   await cacheSetJson(
      cacheKey,
      comparison,
      INVOICE_COMPARISON_CACHE_TTL_SECONDS
   );
   return comparison;
}
