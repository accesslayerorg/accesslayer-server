-- CreateTable
CREATE TABLE "key_leaderboards" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "volume" BIGINT NOT NULL,
    "pnl" BIGINT NOT NULL,
    "holdingDays" BIGINT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "key_leaderboards_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "key_leaderboards_volume_check" CHECK ("volume" >= 0),
    CONSTRAINT "key_leaderboards_holding_days_check" CHECK ("holdingDays" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "key_leaderboards_creatorId_wallet_key"
ON "key_leaderboards"("creatorId", "wallet");

-- CreateIndex
CREATE INDEX "key_leaderboards_creatorId_volume_idx"
ON "key_leaderboards"("creatorId", "volume" DESC, "wallet");

-- CreateIndex
CREATE INDEX "key_leaderboards_creatorId_pnl_idx"
ON "key_leaderboards"("creatorId", "pnl" DESC, "wallet");

-- CreateIndex
CREATE INDEX "key_leaderboards_creatorId_holdingDays_idx"
ON "key_leaderboards"("creatorId", "holdingDays" DESC, "wallet");
