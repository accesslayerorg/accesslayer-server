-- Referral tier tracking + tier upgrade history (#1034)
CREATE TABLE "referral_tiers" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "tier" INTEGER NOT NULL DEFAULT 1,
    "cumulativeVolume" DECIMAL(20,7) NOT NULL DEFAULT 0,
    "lastUpgradedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_tiers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "referral_tiers_walletAddress_key" ON "referral_tiers"("walletAddress");

-- CreateIndex
CREATE INDEX "referral_tiers_tier_idx" ON "referral_tiers"("tier");

-- CreateTable
CREATE TABLE "referral_tier_events" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "previousTier" INTEGER NOT NULL,
    "newTier" INTEGER NOT NULL,
    "cumulativeVolume" DECIMAL(20,7) NOT NULL,
    "ledger" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_tier_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "referral_tier_events_txHash_eventIndex_key" ON "referral_tier_events"("txHash", "eventIndex");

-- CreateIndex
CREATE INDEX "referral_tier_events_walletAddress_occurredAt_idx" ON "referral_tier_events"("walletAddress", "occurredAt" DESC);
