// src/modules/invoice/invoice.controllers.test.ts
import express, { Express } from 'express';
import supertest from 'supertest';

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

jest.mock('./invoice.service', () => {
   const actual = jest.requireActual('./invoice.service');
   return {
      ...actual,
      getInvoiceComparison: jest.fn(),
   };
});

import { getInvoiceComparison, InvoiceNotFoundError } from './invoice.service';
import invoiceRouter from './invoice.routes';

const mockGetComparison = getInvoiceComparison as jest.Mock;

const metrics = (id: string) => ({
   invoice_id: id,
   seller_wallet: 'GSELLER',
   currency: 'USDC',
   status: 'FUNDED',
   amount: '1000',
   rate: '0.05',
   maturity: '2026-12-31T00:00:00.000Z',
   risk_rating: 'A',
   funding_progress: '1',
   seller_stats: {
      wallet: 'GSELLER',
      invoice_count: 1,
      total_amount: '1000',
      average_rate: '0.05',
   },
});

describe('Invoice Comparison Routes', () => {
   let app: Express;

   beforeAll(() => {
      app = express();
      app.use(express.json());
      app.use('/invoices', invoiceRouter);
   });

   beforeEach(() => {
      jest.clearAllMocks();
      mockGetComparison.mockResolvedValue({
         invoice_ids: ['inv_a', 'inv_b'],
         invoices: { inv_a: metrics('inv_a'), inv_b: metrics('inv_b') },
      });
   });

   it('returns 400 when ids is missing', async () => {
      const res = await supertest(app).get('/invoices/compare');

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(mockGetComparison).not.toHaveBeenCalled();
   });

   it('returns 400 when ids contains no usable values', async () => {
      const res = await supertest(app).get('/invoices/compare?ids=,,,');

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(mockGetComparison).not.toHaveBeenCalled();
   });

   it('returns 400 with a clear error when more than 2 ids are provided', async () => {
      const res = await supertest(app).get(
         '/invoices/compare?ids=inv_a,inv_b,inv_c'
      );

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('Maximum 2 invoice IDs allowed');
      expect(res.body.error.details).toEqual([
         expect.objectContaining({ field: 'ids' }),
      ]);
      expect(mockGetComparison).not.toHaveBeenCalled();
   });

   it('returns 404 when an invoice does not exist', async () => {
      mockGetComparison.mockRejectedValue(
         new InvoiceNotFoundError(['inv_missing'])
      );

      const res = await supertest(app).get(
         '/invoices/compare?ids=inv_a,inv_missing'
      );

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
   });

   it('returns metrics grouped by invoice id for two invoices', async () => {
      const res = await supertest(app).get('/invoices/compare?ids=inv_a,inv_b');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.invoice_ids).toEqual(['inv_a', 'inv_b']);
      expect(res.body.data.invoices.inv_a.amount).toBe('1000');
      expect(res.body.data.invoices.inv_a.maturity).toBe(
         '2026-12-31T00:00:00.000Z'
      );
      expect(res.body.data.invoices.inv_a.seller_stats.invoice_count).toBe(1);
      expect(mockGetComparison).toHaveBeenCalledWith(['inv_a', 'inv_b']);
   });

   it('supports comparing a single invoice', async () => {
      mockGetComparison.mockResolvedValue({
         invoice_ids: ['inv_a'],
         invoices: { inv_a: metrics('inv_a') },
      });

      const res = await supertest(app).get('/invoices/compare?ids=inv_a');

      expect(res.status).toBe(200);
      expect(res.body.data.invoice_ids).toEqual(['inv_a']);
   });

   it('trims whitespace and de-duplicates ids', async () => {
      await supertest(app).get('/invoices/compare?ids=%20inv_a%20,inv_b,inv_a');

      expect(mockGetComparison).toHaveBeenCalledWith(['inv_a', 'inv_b']);
   });

   it('sets a 30 second public cache header', async () => {
      const res = await supertest(app).get('/invoices/compare?ids=inv_a,inv_b');

      expect(res.headers['cache-control']).toBe('public, max-age=30');
   });
});
