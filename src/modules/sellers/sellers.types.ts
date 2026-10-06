// src/modules/sellers/sellers.types.ts

export interface OnboardingStepStatus {
   completed: boolean;
   completed_at: string | null;
}

export interface SellerOnboardingStatus {
   wallet_address: string;
   onboarding_complete: boolean;
   steps: {
      wallet_connected: OnboardingStepStatus;
      kyc_approved: OnboardingStepStatus;
      first_invoice_submitted: OnboardingStepStatus;
   };
}
