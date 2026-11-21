-- Referral earnings indexer + REST endpoints (#1057)
CREATE TABLE "referral_earnings" (
    "id" TEXT NOT NULL,
    "referrerWallet" TEXT NOT NULL,
    "sourceWallet" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "amount" DECIMAL(20,7) NOT NULL,
    "ledger" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "earnedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_earnings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "referral_earnings_txHash_eventIndex_key" ON "referral_earnings"("txHash", "eventIndex");

-- CreateIndex
CREATE INDEX "referral_earnings_referrerWallet_earnedAt_idx" ON "referral_earnings"("referrerWallet", "earnedAt" DESC);

-- CreateIndex
CREATE INDEX "referral_earnings_referrerWallet_tier_idx" ON "referral_earnings"("referrerWallet", "tier");

-- CreateIndex
CREATE INDEX "referral_earnings_sourceWallet_idx" ON "referral_earnings"("sourceWallet");
