-- CreateTable
CREATE TABLE "badge_mint_log" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "badgeType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "triggerEvent" TEXT NOT NULL,
    "txHash" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "metadata" JSONB,
    "mintedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "badge_mint_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "badge_mint_log_wallet_badgeType_key" ON "badge_mint_log"("wallet", "badgeType");
CREATE INDEX "badge_mint_log_wallet_idx" ON "badge_mint_log"("wallet");
CREATE INDEX "badge_mint_log_badgeType_idx" ON "badge_mint_log"("badgeType");
CREATE INDEX "badge_mint_log_status_idx" ON "badge_mint_log"("status");
