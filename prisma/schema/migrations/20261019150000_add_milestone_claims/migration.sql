-- CreateTable
CREATE TABLE "milestone_claims" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "milestoneId" TEXT NOT NULL,
    "tier" INTEGER,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "txHash" TEXT,
    "blockNumber" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "milestone_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "milestone_claims_keyId_wallet_milestoneId_key" ON "milestone_claims"("keyId", "wallet", "milestoneId");

-- CreateIndex
CREATE INDEX "milestone_claims_wallet_idx" ON "milestone_claims"("wallet");

-- CreateIndex
CREATE INDEX "milestone_claims_keyId_wallet_idx" ON "milestone_claims"("keyId", "wallet");
