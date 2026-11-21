-- #1008: Portfolio performance history endpoint
-- Append-only holdings snapshots written on every trade event so
-- GET /portfolio/history can reconstruct a wallet's balances at each
-- interval and multiply them by the price recorded at that interval.

-- CreateTable
CREATE TABLE "wallet_holding_snapshots" (
    "id" TEXT NOT NULL,
    "ownerAddress" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "balance" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_holding_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wallet_holding_snapshots_ownerAddress_recordedAt_idx" ON "wallet_holding_snapshots"("ownerAddress", "recordedAt");

-- CreateIndex
CREATE INDEX "wallet_holding_snapshots_ownerAddress_creatorId_recordedAt_idx" ON "wallet_holding_snapshots"("ownerAddress", "creatorId", "recordedAt");
