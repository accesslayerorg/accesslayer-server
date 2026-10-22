CREATE TABLE "milestone_claims" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "milestoneDays" INTEGER NOT NULL,
    "rewardAmount" DECIMAL(36,7),
    "claimedAt" TIMESTAMP(3) NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "ledger" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "milestone_claims_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "milestone_claims_txHash_eventIndex_key" ON "milestone_claims"("txHash", "eventIndex");
CREATE UNIQUE INDEX "milestone_claims_keyId_wallet_milestoneDays_key" ON "milestone_claims"("keyId", "wallet", "milestoneDays");
CREATE INDEX "milestone_claims_wallet_keyId_idx" ON "milestone_claims"("wallet", "keyId");
