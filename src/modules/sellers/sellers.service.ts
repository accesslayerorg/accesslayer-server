// src/modules/sellers/sellers.service.ts
import { prisma } from '../../utils/prisma.utils';
import { SellerOnboardingStatus } from './sellers.types';

/**
 * Get seller onboarding checklist completion status for a given wallet address.
 *
 * Checks source records:
 * 1. wallet_connected: StellarWallet record by address
 * 2. kyc_approved: KycRecord by walletAddress (status === 'APPROVED') or CreatorProfile isVerified
 * 3. first_invoice_submitted: earliest Invoice created by sellerWallet
 */
export async function getSellerOnboardingStatus(
   walletAddress: string
): Promise<SellerOnboardingStatus> {
   const [walletRecord, kycRecord, firstInvoice] = await Promise.all([
      prisma.stellarWallet.findUnique({
         where: { address: walletAddress },
         select: { createdAt: true },
      }),
      prisma.kycRecord.findUnique({
         where: { walletAddress },
         select: { status: true, approvedAt: true, createdAt: true },
      }),
      prisma.invoice.findFirst({
         where: { sellerWallet: walletAddress },
         orderBy: { createdAt: 'asc' },
         select: { createdAt: true },
      }),
   ]);

   // Step 1: wallet_connected
   const walletConnected = Boolean(walletRecord);
   const walletConnectedAt = walletRecord
      ? walletRecord.createdAt.toISOString()
      : null;

   // Step 2: kyc_approved
   let kycApproved = false;
   let kycApprovedAt: string | null = null;

   if (kycRecord && kycRecord.status.toUpperCase() === 'APPROVED') {
      kycApproved = true;
      kycApprovedAt = (
         kycRecord.approvedAt ?? kycRecord.createdAt
      ).toISOString();
   } else {
      // Fallback check: CreatorProfile associated with the StellarWallet isVerified
      const creatorProfile = await prisma.creatorProfile.findFirst({
         where: {
            user: {
               stellarWallet: {
                  address: walletAddress,
               },
            },
         },
         select: { isVerified: true, updatedAt: true },
      });

      if (creatorProfile?.isVerified) {
         kycApproved = true;
         kycApprovedAt = creatorProfile.updatedAt.toISOString();
      }
   }

   // Step 3: first_invoice_submitted
   const firstInvoiceSubmitted = Boolean(firstInvoice);
   const firstInvoiceSubmittedAt = firstInvoice
      ? firstInvoice.createdAt.toISOString()
      : null;

   const onboardingComplete =
      walletConnected && kycApproved && firstInvoiceSubmitted;

   return {
      wallet_address: walletAddress,
      onboarding_complete: onboardingComplete,
      steps: {
         wallet_connected: {
            completed: walletConnected,
            completed_at: walletConnectedAt,
         },
         kyc_approved: {
            completed: kycApproved,
            completed_at: kycApprovedAt,
         },
         first_invoice_submitted: {
            completed: firstInvoiceSubmitted,
            completed_at: firstInvoiceSubmittedAt,
         },
      },
   };
}
