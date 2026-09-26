// src/modules/sellers/sellers.routes.test.ts
import express, { Express } from 'express';
import supertest from 'supertest';

jest.mock('../../utils/prisma.utils', () => ({
   prisma: {
      stellarWallet: {
         findUnique: jest.fn(),
      },
      kycRecord: {
         findUnique: jest.fn(),
      },
      invoice: {
         findFirst: jest.fn(),
      },
      creatorProfile: {
         findFirst: jest.fn(),
      },
   },
}));

import { prisma } from '../../utils/prisma.utils';
import sellersRouter from './sellers.routes';
import { signWalletAccessToken } from '../../utils/jwt.utils';

const mockWalletFindUnique = prisma.stellarWallet.findUnique as jest.Mock;
const mockKycFindUnique = prisma.kycRecord.findUnique as jest.Mock;
const mockInvoiceFindFirst = prisma.invoice.findFirst as jest.Mock;
const mockCreatorFindFirst = prisma.creatorProfile.findFirst as jest.Mock;

const WALLET = 'GA5XIGA5C7GTGTW7ZKJ4YV6OEILUY2Q7YIHZQNNDJUWAVES4O7D5SUK9';

describe('Seller Routes - GET /sellers/onboarding-status', () => {
   let app: Express;
   let token: string;

   beforeAll(() => {
      token = signWalletAccessToken(WALLET);

      app = express();
      app.use(express.json());
      app.use('/sellers', sellersRouter);
   });

   beforeEach(() => {
      jest.clearAllMocks();
   });

   describe('Authentication Enforcement', () => {
      it('returns 401 UNAUTHORIZED when no Authorization header is provided', async () => {
         const res = await supertest(app).get('/sellers/onboarding-status');
         expect(res.status).toBe(401);
         expect(res.body.success).toBe(false);
         expect(res.body.error.code).toBe('UNAUTHORIZED');
      });

      it('returns 401 JWT_ERROR when an invalid token is provided', async () => {
         const res = await supertest(app)
            .get('/sellers/onboarding-status')
            .set('Authorization', 'Bearer invalid.token.value');
         expect(res.status).toBe(401);
         expect(res.body.success).toBe(false);
      });
   });

   describe('GET /sellers/onboarding-status', () => {
      it('returns 200 with complete onboarding status for authenticated seller wallet', async () => {
         const walletDate = new Date('2026-09-01T00:00:00.000Z');
         const kycDate = new Date('2026-09-02T00:00:00.000Z');
         const invoiceDate = new Date('2026-09-03T00:00:00.000Z');

         mockWalletFindUnique.mockResolvedValue({ createdAt: walletDate });
         mockKycFindUnique.mockResolvedValue({
            status: 'APPROVED',
            approvedAt: kycDate,
            createdAt: kycDate,
         });
         mockInvoiceFindFirst.mockResolvedValue({ createdAt: invoiceDate });

         const res = await supertest(app)
            .get('/sellers/onboarding-status')
            .set('Authorization', `Bearer ${token}`);

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data).toEqual({
            wallet_address: WALLET,
            onboarding_complete: true,
            steps: {
               wallet_connected: {
                  completed: true,
                  completed_at: walletDate.toISOString(),
               },
               kyc_approved: {
                  completed: true,
                  completed_at: kycDate.toISOString(),
               },
               first_invoice_submitted: {
                  completed: true,
                  completed_at: invoiceDate.toISOString(),
               },
            },
         });
      });

      it('returns onboarding_complete = false when steps are pending', async () => {
         const walletDate = new Date('2026-09-01T00:00:00.000Z');

         mockWalletFindUnique.mockResolvedValue({ createdAt: walletDate });
         mockKycFindUnique.mockResolvedValue(null);
         mockCreatorFindFirst.mockResolvedValue(null);
         mockInvoiceFindFirst.mockResolvedValue(null);

         const res = await supertest(app)
            .get('/sellers/onboarding-status')
            .set('Authorization', `Bearer ${token}`);

         expect(res.status).toBe(200);
         expect(res.body.success).toBe(true);
         expect(res.body.data.onboarding_complete).toBe(false);
         expect(res.body.data.steps.wallet_connected.completed).toBe(true);
         expect(res.body.data.steps.kyc_approved.completed).toBe(false);
         expect(res.body.data.steps.first_invoice_submitted.completed).toBe(
            false
         );
      });
   });
});
