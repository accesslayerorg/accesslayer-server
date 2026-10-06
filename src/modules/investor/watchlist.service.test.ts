// src/modules/investor/watchlist.service.test.ts
import { Decimal } from '@prisma/client/runtime/library';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      invoice: {
         findUnique: jest.fn(),
      },
      investorWatchlist: {
         findUnique: jest.fn(),
         upsert: jest.fn(),
         delete: jest.fn(),
         findMany: jest.fn(),
         updateMany: jest.fn(),
      },
   },
}));

import { prisma } from '../../utils/prisma.utils';
import {
   addToWatchlist,
   removeFromWatchlist,
   getWatchlist,
   InvoiceNotFoundError,
   WatchlistNotFoundError,
} from './watchlist.service';

const mockInvoiceFindUnique = prisma.invoice.findUnique as jest.Mock;
const mockWatchlistFindUnique = prisma.investorWatchlist
   .findUnique as jest.Mock;
const mockWatchlistUpsert = prisma.investorWatchlist.upsert as jest.Mock;
const mockWatchlistDelete = prisma.investorWatchlist.delete as jest.Mock;
const mockWatchlistFindMany = prisma.investorWatchlist.findMany as jest.Mock;
const mockWatchlistUpdateMany = prisma.investorWatchlist
   .updateMany as jest.Mock;

const WALLET = 'GA5XIGA5C7GTGTW7ZKJ4YV6OEILUY2Q7YIHZQNNDJUWAVES4O7D5SUK9';
const INVOICE_ID = 'inv_test_123';

describe('Watchlist Service Unit Tests', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('addToWatchlist', () => {
      it('throws InvoiceNotFoundError when invoice does not exist', async () => {
         mockInvoiceFindUnique.mockResolvedValue(null);

         await expect(addToWatchlist(WALLET, INVOICE_ID)).rejects.toThrow(
            InvoiceNotFoundError
         );
         expect(mockInvoiceFindUnique).toHaveBeenCalledWith({
            where: { id: INVOICE_ID },
         });
         expect(mockWatchlistUpsert).not.toHaveBeenCalled();
      });

      it('adds invoice to watchlist successfully when invoice exists', async () => {
         mockInvoiceFindUnique.mockResolvedValue({
            id: INVOICE_ID,
            status: 'PENDING',
         });
         const now = new Date();
         const createdEntry = {
            id: 'wl_entry_1',
            walletAddress: WALLET,
            invoiceId: INVOICE_ID,
            lastSeen: now,
            createdAt: now,
            updatedAt: now,
         };
         mockWatchlistUpsert.mockResolvedValue(createdEntry);

         const result = await addToWatchlist(WALLET, INVOICE_ID);

         expect(result).toEqual({
            id: 'wl_entry_1',
            wallet_address: WALLET,
            invoice_id: INVOICE_ID,
            last_seen: now.toISOString(),
            created_at: now.toISOString(),
            updated_at: now.toISOString(),
         });
         expect(mockWatchlistUpsert).toHaveBeenCalledWith({
            where: {
               walletAddress_invoiceId: {
                  walletAddress: WALLET,
                  invoiceId: INVOICE_ID,
               },
            },
            update: {},
            create: {
               walletAddress: WALLET,
               invoiceId: INVOICE_ID,
               lastSeen: expect.any(Date),
            },
         });
      });
   });

   describe('removeFromWatchlist', () => {
      it('throws WatchlistNotFoundError when entry is not found', async () => {
         mockWatchlistFindUnique.mockResolvedValue(null);

         await expect(removeFromWatchlist(WALLET, INVOICE_ID)).rejects.toThrow(
            WatchlistNotFoundError
         );
         expect(mockWatchlistDelete).not.toHaveBeenCalled();
      });

      it('deletes entry from watchlist when found', async () => {
         mockWatchlistFindUnique.mockResolvedValue({
            id: 'wl_entry_1',
            walletAddress: WALLET,
            invoiceId: INVOICE_ID,
         });
         mockWatchlistDelete.mockResolvedValue({ id: 'wl_entry_1' });

         const result = await removeFromWatchlist(WALLET, INVOICE_ID);

         expect(result).toEqual({ removed: true, invoice_id: INVOICE_ID });
         expect(mockWatchlistDelete).toHaveBeenCalledWith({
            where: { id: 'wl_entry_1' },
         });
      });
   });

   describe('getWatchlist', () => {
      it('returns empty array when wallet has no watched invoices', async () => {
         mockWatchlistFindMany.mockResolvedValue([]);

         const result = await getWatchlist(WALLET);

         expect(result).toEqual([]);
         expect(mockWatchlistUpdateMany).not.toHaveBeenCalled();
      });

      it('returns watched invoices, calculates status_changed comparison, and updates last_seen', async () => {
         const pastTime = new Date('2026-09-25T10:00:00.000Z');
         const newerTime = new Date('2026-09-25T12:00:00.000Z');
         const evenNewerTime = new Date('2026-09-25T14:00:00.000Z');

         const mockEntries = [
            {
               id: 'wl_1',
               walletAddress: WALLET,
               invoiceId: 'inv_1',
               lastSeen: newerTime,
               createdAt: pastTime,
               invoice: {
                  id: 'inv_1',
                  sellerWallet: 'GSELLER1',
                  amount: new Decimal(1000),
                  currency: 'USDC',
                  status: 'FUNDED',
                  statusUpdatedAt: pastTime, // Not changed since lastSeen
                  rate: new Decimal(0.05),
                  maturityDate: new Date('2026-12-31'),
                  riskRating: 'A',
                  fundingProgress: new Decimal(1),
                  createdAt: pastTime,
                  updatedAt: pastTime,
               },
            },
            {
               id: 'wl_2',
               walletAddress: WALLET,
               invoiceId: 'inv_2',
               lastSeen: pastTime,
               createdAt: pastTime,
               invoice: {
                  id: 'inv_2',
                  sellerWallet: 'GSELLER2',
                  amount: new Decimal(2500),
                  currency: 'USDC',
                  status: 'REPAID',
                  statusUpdatedAt: evenNewerTime, // Changed after lastSeen
                  rate: new Decimal(0.07),
                  maturityDate: new Date('2026-11-30'),
                  riskRating: 'B+',
                  fundingProgress: new Decimal(1),
                  createdAt: pastTime,
                  updatedAt: evenNewerTime,
               },
            },
         ];

         mockWatchlistFindMany.mockResolvedValue(mockEntries);
         mockWatchlistUpdateMany.mockResolvedValue({ count: 2 });

         const result = await getWatchlist(WALLET);

         expect(result).toHaveLength(2);

         // inv_1: statusUpdatedAt (10:00) <= lastSeen (12:00) -> status_changed = false
         expect(result[0].invoice_id).toBe('inv_1');
         expect(result[0].status_changed).toBe(false);
         expect(result[0].invoice.status).toBe('FUNDED');

         // inv_2: statusUpdatedAt (14:00) > lastSeen (10:00) -> status_changed = true
         expect(result[1].invoice_id).toBe('inv_2');
         expect(result[1].status_changed).toBe(true);
         expect(result[1].invoice.status).toBe('REPAID');

         // Verifies lastSeen is updated for all returned items
         expect(mockWatchlistUpdateMany).toHaveBeenCalledWith({
            where: {
               walletAddress: WALLET,
               id: { in: ['wl_1', 'wl_2'] },
            },
            data: {
               lastSeen: expect.any(Date),
            },
         });
      });
   });
});
