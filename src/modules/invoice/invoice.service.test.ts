// src/modules/invoice/invoice.service.test.ts
import { Decimal } from '@prisma/client/runtime/library';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      invoice: {
         findMany: jest.fn(),
         groupBy: jest.fn(),
      },
   },
}));

jest.mock('../../utils/redis.utils', () => ({
   cacheGetJson: jest.fn(),
   cacheSetJson: jest.fn(),
}));

import { prisma } from '../../utils/prisma.utils';
import { cacheGetJson, cacheSetJson } from '../../utils/redis.utils';
import {
   fetchInvoiceComparison,
   getInvoiceComparison,
   invoiceComparisonCacheKey,
   InvoiceNotFoundError,
} from './invoice.service';
import { INVOICE_COMPARISON_CACHE_TTL_SECONDS } from './invoice.schemas';

const mockFindMany = prisma.invoice.findMany as jest.Mock;
const mockGroupBy = prisma.invoice.groupBy as jest.Mock;
const mockCacheGetJson = cacheGetJson as jest.Mock;
const mockCacheSetJson = cacheSetJson as jest.Mock;

const SELLER_A = 'GSELLER_A';
const SELLER_B = 'GSELLER_B';

const invoiceRow = (id: string, sellerWallet: string) => ({
   id,
   sellerWallet,
   currency: 'USDC',
   status: 'FUNDED',
   amount: new Decimal(1000),
   rate: new Decimal(0.05),
   maturityDate: new Date('2026-12-31T00:00:00.000Z'),
   riskRating: 'A',
   fundingProgress: new Decimal(1),
});

const sellerStatsGroup = (sellerWallet: string, count: number) => ({
   sellerWallet,
   _count: { _all: count },
   _sum: { amount: new Decimal(1000 * count) },
   _avg: { rate: new Decimal(0.05) },
});

describe('Invoice comparison service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
      mockCacheGetJson.mockResolvedValue(null);
      mockCacheSetJson.mockResolvedValue(undefined);
   });

   describe('invoiceComparisonCacheKey', () => {
      it('is order independent', () => {
         expect(invoiceComparisonCacheKey(['b', 'a'])).toBe(
            invoiceComparisonCacheKey(['a', 'b'])
         );
      });

      it('namespaces the key', () => {
         expect(invoiceComparisonCacheKey(['a', 'b'])).toBe(
            'invoice:compare:a,b'
         );
      });
   });

   describe('fetchInvoiceComparison', () => {
      it('throws InvoiceNotFoundError listing the missing ids', async () => {
         mockFindMany.mockResolvedValue([invoiceRow('inv_a', SELLER_A)]);

         await expect(
            fetchInvoiceComparison(['inv_a', 'inv_missing'])
         ).rejects.toBeInstanceOf(InvoiceNotFoundError);
         expect(mockGroupBy).not.toHaveBeenCalled();
      });

      it('groups metrics by invoice id in the requested order', async () => {
         mockFindMany.mockResolvedValue([
            invoiceRow('inv_a', SELLER_A),
            invoiceRow('inv_b', SELLER_B),
         ]);
         mockGroupBy.mockResolvedValue([
            sellerStatsGroup(SELLER_A, 2),
            sellerStatsGroup(SELLER_B, 1),
         ]);

         const result = await fetchInvoiceComparison(['inv_b', 'inv_a']);

         expect(result.invoice_ids).toEqual(['inv_b', 'inv_a']);
         expect(Object.keys(result.invoices)).toEqual(['inv_b', 'inv_a']);

         expect(result.invoices.inv_b).toMatchObject({
            invoice_id: 'inv_b',
            seller_wallet: SELLER_B,
            amount: '1000',
            currency: 'USDC',
            rate: '0.05',
            maturity: '2026-12-31T00:00:00.000Z',
            risk_rating: 'A',
            funding_progress: '1',
         });
         expect(result.invoices.inv_b.seller_stats).toEqual({
            wallet: SELLER_B,
            invoice_count: 1,
            total_amount: '1000',
            average_rate: '0.05',
         });
      });

      it('nulls optional fields and aggregates each seller once', async () => {
         mockFindMany.mockResolvedValue([
            {
               ...invoiceRow('inv_a', SELLER_A),
               rate: null,
               maturityDate: null,
               riskRating: null,
            },
            invoiceRow('inv_b', SELLER_A),
         ]);
         mockGroupBy.mockResolvedValue([sellerStatsGroup(SELLER_A, 5)]);

         const result = await fetchInvoiceComparison(['inv_a', 'inv_b']);

         expect(result.invoices.inv_a).toMatchObject({
            rate: null,
            maturity: null,
            risk_rating: null,
         });
         expect(mockGroupBy).toHaveBeenCalledWith(
            expect.objectContaining({
               by: ['sellerWallet'],
               where: { sellerWallet: { in: [SELLER_A] } },
            })
         );
         expect(result.invoices.inv_a.seller_stats.invoice_count).toBe(5);
         expect(result.invoices.inv_b.seller_stats.invoice_count).toBe(5);
      });
   });

   describe('getInvoiceComparison', () => {
      it('queries the database and caches on a miss', async () => {
         mockFindMany.mockResolvedValue([
            invoiceRow('inv_a', SELLER_A),
            invoiceRow('inv_b', SELLER_B),
         ]);
         mockGroupBy.mockResolvedValue([
            sellerStatsGroup(SELLER_A, 1),
            sellerStatsGroup(SELLER_B, 1),
         ]);

         await getInvoiceComparison(['inv_a', 'inv_b']);

         expect(mockCacheSetJson).toHaveBeenCalledWith(
            'invoice:compare:inv_a,inv_b',
            expect.objectContaining({ invoice_ids: ['inv_a', 'inv_b'] }),
            INVOICE_COMPARISON_CACHE_TTL_SECONDS
         );
      });

      it('serves from cache and restores the requested order', async () => {
         mockCacheGetJson.mockResolvedValue({
            invoice_ids: ['inv_b', 'inv_a'],
            invoices: {
               inv_a: { invoice_id: 'inv_a' },
               inv_b: { invoice_id: 'inv_b' },
            },
         });

         const result = await getInvoiceComparison(['inv_a', 'inv_b']);

         expect(mockFindMany).not.toHaveBeenCalled();
         expect(mockCacheSetJson).not.toHaveBeenCalled();
         expect(result.invoice_ids).toEqual(['inv_a', 'inv_b']);
         expect(Object.keys(result.invoices)).toEqual(['inv_a', 'inv_b']);
      });

      it('does not cache failures', async () => {
         mockFindMany.mockResolvedValue([]);

         await expect(
            getInvoiceComparison(['inv_a', 'inv_b'])
         ).rejects.toBeInstanceOf(InvoiceNotFoundError);
         expect(mockCacheSetJson).not.toHaveBeenCalled();
      });
   });
});
