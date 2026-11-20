-- Referral abuse detection (#1241): withheld rewards and cached funding sources.

-- CreateEnum
CREATE TYPE "ReferralHoldStatus" AS ENUM ('PENDING', 'RELEASED', 'REJECTED');

-- CreateTable
CREATE TABLE "ReferralHold" (
    "id" TEXT NOT NULL,
    "referralId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ReferralHoldStatus" NOT NULL DEFAULT 'PENDING',
    "details" JSONB,
    "referrerAddress" TEXT NOT NULL,
    "refereeAddress" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "rewardXlm" DECIMAL(20,7) NOT NULL,
    "txHash" TEXT,
    "eventIndex" INTEGER,
    "tradedAt" TIMESTAMP(3) NOT NULL,
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletFundingSource" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "funder" TEXT NOT NULL,
    "fundedAt" TIMESTAMP(3) NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletFundingSource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferralHold_referralId_key" ON "ReferralHold"("referralId");

CREATE INDEX "ReferralHold_status_createdAt_idx" ON "ReferralHold"("status", "createdAt");

CREATE UNIQUE INDEX "WalletFundingSource_address_key" ON "WalletFundingSource"("address");

CREATE INDEX "WalletFundingSource_funder_fundedAt_idx" ON "WalletFundingSource"("funder", "fundedAt");

-- AddForeignKey
ALTER TABLE "ReferralHold" ADD CONSTRAINT "ReferralHold_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "Referral"("id") ON DELETE CASCADE ON UPDATE CASCADE;
