-- Referral tracking and reward distribution (#910): referral codes issued per
-- wallet, the referee -> referrer relationship, and the referred-wallet column
-- on the referral fee ledger so earnings can be broken down per referral.

-- CreateTable
CREATE TABLE "ReferralCode" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Referral" (
    "id" TEXT NOT NULL,
    "referrerAddress" TEXT NOT NULL,
    "refereeAddress" TEXT NOT NULL,
    "referralCode" TEXT NOT NULL,
    "firstTradeAt" TIMESTAMP(3),
    "firstTradeKeyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Referral_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCode_walletAddress_key" ON "ReferralCode"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCode_code_key" ON "ReferralCode"("code");

-- CreateIndex
CREATE INDEX "ReferralCode_walletAddress_idx" ON "ReferralCode"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Referral_refereeAddress_key" ON "Referral"("refereeAddress");

-- CreateIndex
CREATE INDEX "Referral_referrerAddress_createdAt_idx" ON "Referral"("referrerAddress", "createdAt");

-- CreateIndex
CREATE INDEX "Referral_referrerAddress_idx" ON "Referral"("referrerAddress");

-- AlterTable
ALTER TABLE "ReferralEvent" ADD COLUMN     "refereeAddress" TEXT;

-- CreateIndex
CREATE INDEX "ReferralEvent_refereeAddress_idx" ON "ReferralEvent"("refereeAddress");
