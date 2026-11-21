// src/modules/investor/watchlist.service.ts
import { prisma } from '../../utils/prisma.utils';

export class InvoiceNotFoundError extends Error {
   constructor(invoiceId?: string) {
      super(
         invoiceId ? `Invoice '${invoiceId}' not found` : 'Invoice not found'
      );
      this.name = 'InvoiceNotFoundError';
   }
}

export class WatchlistNotFoundError extends Error {
   constructor(invoiceId?: string) {
      super(
         invoiceId
            ? `Invoice '${invoiceId}' not found in watchlist`
            : 'Watchlist entry not found'
      );
      this.name = 'WatchlistNotFoundError';
   }
}

function toISO(val: unknown): string {
   if (val instanceof Date) return val.toISOString();
   if (typeof val === 'string') {
      const d = new Date(val);
      return isNaN(d.getTime()) ? val : d.toISOString();
   }
   return new Date().toISOString();
}

function toOptionalISO(val: unknown): string | null {
   if (!val) return null;
   if (val instanceof Date) return val.toISOString();
   if (typeof val === 'string') {
      const d = new Date(val);
      return isNaN(d.getTime()) ? val : d.toISOString();
   }
   return null;
}

/**
 * Add an invoice to the authenticated investor wallet's watchlist.
 */
export async function addToWatchlist(walletAddress: string, invoiceId: string) {
   const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
   });

   if (!invoice) {
      throw new InvoiceNotFoundError(invoiceId);
   }

   const entry = await prisma.investorWatchlist.upsert({
      where: {
         walletAddress_invoiceId: {
            walletAddress,
            invoiceId,
         },
      },
      update: {},
      create: {
         walletAddress,
         invoiceId,
         lastSeen: new Date(),
      },
   });

   return {
      id: entry.id,
      wallet_address: entry.walletAddress,
      invoice_id: entry.invoiceId,
      last_seen: toISO(entry.lastSeen),
      created_at: toISO(entry.createdAt),
      updated_at: toISO(entry.updatedAt),
   };
}

/**
 * Remove an invoice from the authenticated investor wallet's watchlist.
 */
export async function removeFromWatchlist(
   walletAddress: string,
   invoiceId: string
) {
   const existing = await prisma.investorWatchlist.findUnique({
      where: {
         walletAddress_invoiceId: {
            walletAddress,
            invoiceId,
         },
      },
   });

   if (!existing) {
      throw new WatchlistNotFoundError(invoiceId);
   }

   await prisma.investorWatchlist.delete({
      where: {
         id: existing.id,
      },
   });

   return { removed: true, invoice_id: invoiceId };
}

/**
 * Retrieve all watched invoices for an authenticated investor wallet.
 * Computes status change comparison against the stored last_seen timestamp,
 * and updates the last_seen timestamp on each GET request.
 */
export async function getWatchlist(walletAddress: string) {
   const items = await prisma.investorWatchlist.findMany({
      where: { walletAddress },
      include: { invoice: true },
      orderBy: { createdAt: 'desc' },
   });

   const mapped = items.map(item => {
      const invoiceStatusTime = item.invoice.statusUpdatedAt
         ? new Date(item.invoice.statusUpdatedAt).getTime()
         : 0;
      const lastSeenTime = item.lastSeen
         ? new Date(item.lastSeen).getTime()
         : 0;
      const hasStatusChanged = invoiceStatusTime > lastSeenTime;

      return {
         id: item.id,
         wallet_address: item.walletAddress,
         invoice_id: item.invoiceId,
         last_seen: toISO(item.lastSeen),
         status_changed: hasStatusChanged,
         created_at: toISO(item.createdAt),
         updated_at: toISO(item.updatedAt),
         invoice: {
            id: item.invoice.id,
            seller_wallet: item.invoice.sellerWallet,
            amount: item.invoice.amount ? item.invoice.amount.toString() : '0',
            currency: item.invoice.currency,
            status: item.invoice.status,
            status_updated_at: toISO(item.invoice.statusUpdatedAt),
            rate: item.invoice.rate ? item.invoice.rate.toString() : null,
            maturity_date: toOptionalISO(item.invoice.maturityDate),
            risk_rating: item.invoice.riskRating ?? null,
            funding_progress: item.invoice.fundingProgress
               ? item.invoice.fundingProgress.toString()
               : '0',
            created_at: toISO(item.invoice.createdAt),
            updated_at: toISO(item.invoice.updatedAt),
         },
      };
   });

   // Update last_seen timestamp on each GET for tracking changes on future visits
   if (items.length > 0) {
      const now = new Date();
      await prisma.investorWatchlist.updateMany({
         where: {
            walletAddress,
            id: { in: items.map(i => i.id) },
         },
         data: {
            lastSeen: now,
         },
      });
   }

   return mapped;
}
