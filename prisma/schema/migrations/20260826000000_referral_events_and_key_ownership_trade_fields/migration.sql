-- AlterTable
ALTER TABLE "KeyOwnership" ADD COLUMN     "costBasis" DECIMAL(65,30),
ADD COLUMN     "lastBuyAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ReferralEvent" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "creatorId" TEXT,
    "amount" DECIMAL(65,30) NOT NULL,
    "txHash" TEXT,
    "eventIndex" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReferralEvent_walletAddress_createdAt_idx" ON "ReferralEvent"("walletAddress", "createdAt");

-- CreateIndex
CREATE INDEX "ReferralEvent_keyId_idx" ON "ReferralEvent"("keyId");
