// src/modules/invoice/invoice-schedule.service.ts
// Invoice payment schedule and next-instalment read model (#1177).
//
// - GET /invoices/:invoice_id/schedule      — all instalments with status, due_date, paid_at
// - GET /invoices/:invoice_id/schedule/next — next due unpaid instalment
// - Overdue status is computed at request time for unpaid instalments past due_date
// - Cached in Redis for 60s and invalidated on InstalmentPaid events

import { prisma } from '../../utils/prisma.utils';
import {
   cacheGetJson,
   cacheInvalidate,
   cacheSetJson,
} from '../../utils/redis.utils';

export const INVOICE_SCHEDULE_CACHE_TTL_SECONDS = 60;

export type InstalmentStatus = 'paid' | 'pending' | 'overdue';

export interface InvoiceInstalmentItem {
   id: string;
   invoice_id: string;
   instalment_number: number;
   amount: string;
   status: InstalmentStatus;
   due_date: string;
   paid_at: string | null;
   tx_hash: string | null;
}

export interface InvoicePaymentSchedule {
   invoice_id: string;
   total_instalments: number;
   paid_count: number;
   pending_count: number;
   overdue_count: number;
   instalments: InvoiceInstalmentItem[];
}

export interface InvoiceNextInstalmentResponse {
   invoice_id: string;
   next_instalment: InvoiceInstalmentItem | null;
   id?: string;
   instalment_number?: number;
   amount?: string;
   status?: InstalmentStatus;
   due_date?: string;
   paid_at?: string | null;
   tx_hash?: string | null;
}

export function invoiceScheduleCacheKey(invoiceId: string): string {
   return `invoice:schedule:${invoiceId}`;
}

export function invoiceScheduleNextCacheKey(invoiceId: string): string {
   return `invoice:schedule:next:${invoiceId}`;
}

export async function invalidateInvoiceScheduleCache(
   invoiceId: string
): Promise<void> {
   await cacheInvalidate(
      invoiceScheduleCacheKey(invoiceId),
      invoiceScheduleNextCacheKey(invoiceId)
   );
}

/**
 * Computes instalment status at request time:
 * - 'paid' when paidAt is present
 * - 'overdue' when unpaid and dueDate is strictly before `now`
 * - 'pending' when unpaid and dueDate is at or after `now`
 */
export function computeInstalmentStatus(
   dueDate: Date | string,
   paidAt: Date | string | null | undefined,
   now: Date = new Date()
): InstalmentStatus {
   if (paidAt !== null && paidAt !== undefined) {
      return 'paid';
   }
   const dueMs =
      dueDate instanceof Date ? dueDate.getTime() : new Date(dueDate).getTime();
   return dueMs < now.getTime() ? 'overdue' : 'pending';
}

function recomputeScheduleStatuses(
   schedule: InvoicePaymentSchedule,
   now: Date = new Date()
): InvoicePaymentSchedule {
   let paidCount = 0;
   let pendingCount = 0;
   let overdueCount = 0;

   const instalments = schedule.instalments.map(item => {
      const status = computeInstalmentStatus(item.due_date, item.paid_at, now);
      if (status === 'paid') paidCount += 1;
      else if (status === 'overdue') overdueCount += 1;
      else pendingCount += 1;
      return {
         ...item,
         status,
      };
   });

   return {
      invoice_id: schedule.invoice_id,
      total_instalments: instalments.length,
      paid_count: paidCount,
      pending_count: pendingCount,
      overdue_count: overdueCount,
      instalments,
   };
}

export function buildInvoiceSchedule(
   invoiceId: string,
   rows: Array<{
      id: string;
      instalmentNumber: number;
      amount: unknown;
      dueDate: Date;
      paidAt: Date | null;
      txHash?: string | null;
   }>,
   now: Date = new Date()
): InvoicePaymentSchedule {
   const sorted = [...rows].sort((a, b) => {
      const diff = a.dueDate.getTime() - b.dueDate.getTime();
      if (diff !== 0) return diff;
      return a.instalmentNumber - b.instalmentNumber;
   });

   const baseInstalments: InvoiceInstalmentItem[] = sorted.map(row => ({
      id: row.id,
      invoice_id: invoiceId,
      instalment_number: row.instalmentNumber,
      amount: Number(row.amount).toFixed(7),
      status: computeInstalmentStatus(row.dueDate, row.paidAt, now),
      due_date: row.dueDate.toISOString(),
      paid_at: row.paidAt ? row.paidAt.toISOString() : null,
      tx_hash: row.txHash ?? null,
   }));

   return recomputeScheduleStatuses(
      {
         invoice_id: invoiceId,
         total_instalments: baseInstalments.length,
         paid_count: 0,
         pending_count: 0,
         overdue_count: 0,
         instalments: baseInstalments,
      },
      now
   );
}

/**
 * Returns the full payment schedule for an invoice, or null when the invoice
 * does not exist and has no indexed instalments.
 */
export async function getInvoiceSchedule(
   invoiceId: string,
   now: Date = new Date()
): Promise<InvoicePaymentSchedule | null> {
   const cacheKey = invoiceScheduleCacheKey(invoiceId);
   try {
      const cached = await cacheGetJson<InvoicePaymentSchedule>(cacheKey);
      if (cached !== null) {
         return recomputeScheduleStatuses(cached, now);
      }
   } catch {
      // Cache read failure falls through to database.
   }

   const [invoice, rows] = await Promise.all([
      prisma.invoice.findUnique({
         where: { id: invoiceId },
         select: { id: true },
      }),
      prisma.instalmentPayment.findMany({
         where: { invoiceId },
         orderBy: [{ dueDate: 'asc' }, { instalmentNumber: 'asc' }],
      }),
   ]);

   if (!invoice && rows.length === 0) {
      return null;
   }

   const schedule = buildInvoiceSchedule(invoiceId, rows, now);
   try {
      await cacheSetJson(
         cacheKey,
         schedule,
         INVOICE_SCHEDULE_CACHE_TTL_SECONDS
      );
   } catch {
      // Cache write failure is non-critical.
   }
   return schedule;
}

/**
 * Returns the next upcoming unpaid instalment (earliest due unpaid instalment),
 * or `{ invoice_id, next_instalment: null }` if all instalments are paid.
 * Returns null if the invoice does not exist.
 */
export async function getNextInvoiceInstalment(
   invoiceId: string,
   now: Date = new Date()
): Promise<InvoiceNextInstalmentResponse | null> {
   const schedule = await getInvoiceSchedule(invoiceId, now);
   if (!schedule) {
      return null;
   }

   const nextItem =
      schedule.instalments.find(item => item.status !== 'paid') ?? null;

   if (!nextItem) {
      return {
         invoice_id: invoiceId,
         next_instalment: null,
      };
   }

   return {
      ...nextItem,
      invoice_id: invoiceId,
      next_instalment: nextItem,
   };
}
