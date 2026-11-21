// src/modules/invoice/invoice.schemas.ts
import { z } from 'zod';

/**
 * Maximum number of invoices a single comparison request may reference (#947).
 */
export const MAX_COMPARABLE_INVOICES = 2;

/**
 * Server-side cache TTL for a comparison response, keyed by invoice
 * combination (#947).
 */
export const INVOICE_COMPARISON_CACHE_TTL_SECONDS = 30;

/**
 * Parses the comma-separated `ids` query parameter into a de-duplicated list
 * that preserves caller order. Returns `[]` when nothing usable was supplied.
 */
export function parseInvoiceIds(raw: string | undefined): string[] {
   if (!raw) return [];
   const seen = new Set<string>();
   const ids: string[] = [];
   for (const part of raw.split(',')) {
      const id = part.trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
   }
   return ids;
}

/**
 * Query schema for `GET /invoices/compare`.
 *
 * Only validates presence/type here; the cardinality rules (`>= 1`,
 * `<= MAX_COMPARABLE_INVOICES`) are enforced in the controller so the error
 * `details` can name the offending field.
 */
export const InvoiceComparisonQuerySchema = z
   .object({
      ids: z.string({ required_error: 'ids query parameter is required' }),
   })
   .passthrough();

export type InvoiceComparisonQuery = z.infer<
   typeof InvoiceComparisonQuerySchema
>;

/** Aggregate statistics derived from a seller's invoice history. */
export const SellerStatsSchema = z.object({
   wallet: z.string(),
   invoice_count: z.number(),
   total_amount: z.string(),
   average_rate: z.string().nullable(),
});

export type SellerStats = z.infer<typeof SellerStatsSchema>;

/**
 * Comparison metrics for a single invoice. Decimal columns are stringified
 * so the payload survives JSON round-trips without precision loss.
 */
export const InvoiceMetricsSchema = z.object({
   invoice_id: z.string(),
   seller_wallet: z.string(),
   currency: z.string(),
   status: z.string(),
   amount: z.string(),
   rate: z.string().nullable(),
   maturity: z.string().nullable(),
   risk_rating: z.string().nullable(),
   funding_progress: z.string(),
   seller_stats: SellerStatsSchema,
});

export type InvoiceMetrics = z.infer<typeof InvoiceMetricsSchema>;

/**
 * Comparison payload: metrics grouped by invoice ID, in the order the IDs were
 * requested.
 */
export const InvoiceComparisonSchema = z.object({
   invoice_ids: z.array(z.string()),
   invoices: z.record(InvoiceMetricsSchema),
});

export type InvoiceComparison = z.infer<typeof InvoiceComparisonSchema>;
