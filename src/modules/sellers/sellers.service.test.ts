// src/modules/sellers/sellers.service.test.ts
import { getSellerOnboardingStatus } from './sellers.service';

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

const mockWalletFindUnique = prisma.stellarWallet.findUnique as jest.Mock;
const mockKycFindUnique = prisma.kycRecord.findUnique as jest.Mock;
const mockInvoiceFindFirst = prisma.invoice.findFirst as jest.Mock;
const mockCreatorFindFirst = prisma.creatorProfile.findFirst as jest.Mock;

const WALLET = 'GA5XIGA5C7GTGTW7ZKJ4YV6OEILUY2Q7YIHZQNNDJUWAVES4O7D5SUK9';

describe('Seller Onboarding Service', () => {
   beforeEach(() => {
      jest.clearAllMocks();
   });

   it('returns all steps uncompleted when no source records exist', async () => {
      mockWalletFindUnique.mockResolvedValue(null);
      mockKycFindUnique.mockResolvedValue(null);
      mockInvoiceFindFirst.mockResolvedValue(null);
      mockCreatorFindFirst.mockResolvedValue(null);

      const status = await getSellerOnboardingStatus(WALLET);

      expect(status).toEqual({
         wallet_address: WALLET,
         onboarding_complete: false,
         steps: {
            wallet_connected: {
               completed: false,
               completed_at: null,
            },
            kyc_approved: {
               completed: false,
               completed_at: null,
            },
            first_invoice_submitted: {
               completed: false,
               completed_at: null,
            },
         },
      });
   });

   it('returns partially completed steps when only wallet is connected', async () => {
      const walletDate = new Date('2026-09-01T10:00:00.000Z');
      mockWalletFindUnique.mockResolvedValue({ createdAt: walletDate });
      mockKycFindUnique.mockResolvedValue(null);
      mockInvoiceFindFirst.mockResolvedValue(null);
      mockCreatorFindFirst.mockResolvedValue(null);

      const status = await getSellerOnboardingStatus(WALLET);

      expect(status.onboarding_complete).toBe(false);
      expect(status.steps.wallet_connected).toEqual({
         completed: true,
         completed_at: walletDate.toISOString(),
      });
      expect(status.steps.kyc_approved.completed).toBe(false);
      expect(status.steps.first_invoice_submitted.completed).toBe(false);
   });

   it('uses KycRecord when approved and returns kyc_approved = true', async () => {
      const walletDate = new Date('2026-09-01T10:00:00.000Z');
      const kycDate = new Date('2026-09-02T12:00:00.000Z');

      mockWalletFindUnique.mockResolvedValue({ createdAt: walletDate });
      mockKycFindUnique.mockResolvedValue({
         status: 'APPROVED',
         approvedAt: kycDate,
         createdAt: kycDate,
      });
      mockInvoiceFindFirst.mockResolvedValue(null);

      const status = await getSellerOnboardingStatus(WALLET);

      expect(status.steps.kyc_approved).toEqual({
         completed: true,
         completed_at: kycDate.toISOString(),
      });
   });

   it('falls back to CreatorProfile isVerified when KycRecord is absent', async () => {
      const walletDate = new Date('2026-09-01T10:00:00.000Z');
      const creatorDate = new Date('2026-09-03T15:00:00.000Z');

      mockWalletFindUnique.mockResolvedValue({ createdAt: walletDate });
      mockKycFindUnique.mockResolvedValue(null);
      mockCreatorFindFirst.mockResolvedValue({
         isVerified: true,
         updatedAt: creatorDate,
      });
      mockInvoiceFindFirst.mockResolvedValue(null);

      const status = await getSellerOnboardingStatus(WALLET);

      expect(status.steps.kyc_approved).toEqual({
         completed: true,
         completed_at: creatorDate.toISOString(),
      });
   });

   it('returns onboarding_complete = true when all three steps are completed', async () => {
      const walletDate = new Date('2026-09-01T10:00:00.000Z');
      const kycDate = new Date('2026-09-02T12:00:00.000Z');
      const invoiceDate = new Date('2026-09-03T14:00:00.000Z');

      mockWalletFindUnique.mockResolvedValue({ createdAt: walletDate });
      mockKycFindUnique.mockResolvedValue({
         status: 'APPROVED',
         approvedAt: kycDate,
         createdAt: kycDate,
      });
      mockInvoiceFindFirst.mockResolvedValue({ createdAt: invoiceDate });

      const status = await getSellerOnboardingStatus(WALLET);

      expect(status.onboarding_complete).toBe(true);
      expect(status.steps).toEqual({
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
      });
   });
});
