// src/modules/investor/watchlist.routes.test.ts
import express, { Express } from 'express';
import supertest from 'supertest';
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
import watchlistRouter from './watchlist.routes';
import { signWalletAccessToken } from '../../utils/jwt.utils';

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

describe('Watchlist Routes Integration Tests', () => {
   let app: Express;
   let token: string;

   beforeAll(() => {
      token = signWalletAccessToken(WALLET);

      app = express();
      app.use(express.json());
      app.use('/watchlist', watchlistRouter);
   });

   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('Authentication Enforcement', () => {
      it('returns 401 UNAUTHORIZED when no token is provided for GET', async () => {
         const res = await supertest(app).get('/watchlist');
         expect(res.status).toBe(401);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('UNAUTHORIZED');
      });

      it('returns 401 UNAUTHORIZED when no token is provided for POST', async () => {
         const res = await supertest(app).post(`/watchlist/${INVOICE_ID}`);
         expect(res.status).toBe(401);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('UNAUTHORIZED');
      });

      it('returns 401 UNAUTHORIZED when no token is provided for DELETE', async () => {
         const res = await supertest(app).delete(`/watchlist/${INVOICE_ID}`);
         expect(res.status).toBe(401);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('UNAUTHORIZED');
      });
   });

   describe('POST /watchlist/:invoice_id', () => {
      it('returns 404 when invoice does not exist', async () => {
         mockInvoiceFindUnique.mockResolvedValue(null);

         const res = await supertest(app)
            .post(`/watchlist/${INVOICE_ID}`)
            .set('Authorization', `Bearer ${token}`);

         expect(res.status).toBe(404);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('NOT_FOUND');
         expect(res.body.error.message).toContain('Invoice not found');
      });

      it('returns 201 and adds invoice to watchlist when valid', async () => {
         mockInvoiceFindUnique.mockResolvedValue({
            id: INVOICE_ID,
            status: 'PENDING',
         });

         const entry = {
            id: 'wl_entry_1',
            walletAddress: WALLET,
            invoiceId: INVOICE_ID,
            lastSeen: new Date().toISOString(),
            createdAt: new Date().toISOString(),
         };
         mockWatchlistUpsert.mockResolvedValue(entry);

         const res = await supertest(app)
            .post(`/watchlist/${INVOICE_ID}`)
            .set('Authorization', `Bearer ${token}`);

         expect(res.status).toBe(201);
         expect(res.body.success).toBe(true);
         expect(res.body.data.invoice_id).toBe(INVOICE_ID);
         expect(res.body.message).toBe('Invoice added to watchlist');
      });
   });

   describe('DELETE /watchlist/:invoice_id', () => {
      it('returns 404 when entry is not in watchlist', async () => {
         mockWatchlistFindUnique.mockResolvedValue(null);

         const res = await supertest(app)
            .delete(`/watchlist/${INVOICE_ID}`)
            .set('Authorization', `Bearer ${token}`);

         expect(res.status).toBe(404);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('NOT_FOUND');
      });

      it('returns 200 and removes invoice from watchlist', async () => {
         mockWatchlistFindUnique.mockResolvedValue({
            id: 'wl_entry_1',
            walletAddress: WALLET,
            invoiceId: INVOICE_ID,
         });
         mockWatchlistDelete.mockResolvedValue({ id: 'wl_entry_1' });

         const res = await supertest(app)
            .delete(`/watchlist/${INVOICE_ID}`)
            .set('Authorization', `Bearer ${token}`);

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data).toEqual({
            removed: true,
            invoice_id: INVOICE_ID,
         });
         expect(res.body.message).toBe('Invoice removed from watchlist');
      });
   });

   describe('GET /watchlist', () => {
      it('returns watched invoices, calculates status comparison, and updates last_seen', async () => {
         const pastTime = new Date('2026-09-25T10:00:00.000Z');
         const newerTime = new Date('2026-09-25T12:00:00.000Z');

         const mockEntries = [
            {
               id: 'wl_1',
               walletAddress: WALLET,
               invoiceId: INVOICE_ID,
               lastSeen: pastTime,
               createdAt: pastTime,
               invoice: {
                  id: INVOICE_ID,
                  sellerWallet: 'GSELLER1',
                  amount: new Decimal(5000),
                  currency: 'USDC',
                  status: 'FUNDED',
                  statusUpdatedAt: newerTime,
                  rate: new Decimal(0.08),
                  maturityDate: new Date('2026-12-31'),
                  riskRating: 'A',
                  fundingProgress: new Decimal(1),
                  createdAt: pastTime,
                  updatedAt: newerTime,
               },
            },
         ];

         mockWatchlistFindMany.mockResolvedValue(mockEntries);
         mockWatchlistUpdateMany.mockResolvedValue({ count: 1 });

         const res = await supertest(app)
            .get('/watchlist')
            .set('Authorization', `Bearer ${token}`);

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data).toHaveLength(1);

         const item = res.body.data[0];
         expect(item.invoice_id).toBe(INVOICE_ID);
         expect(item.status_changed).toBe(true);
         expect(item.invoice.status).toBe('FUNDED');
         expect(item.last_seen).toBe(pastTime.toISOString());

         expect(mockWatchlistUpdateMany).toHaveBeenCalledWith({
            where: {
               walletAddress: WALLET,
               id: { in: ['wl_1'] },
            },
            data: {
               lastSeen: expect.any(Date),
            },
         });
      });
   });
});
