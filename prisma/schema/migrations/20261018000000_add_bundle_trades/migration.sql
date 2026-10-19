-- CreateTable
CREATE TABLE "bundle_trades" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "buyer" TEXT NOT NULL DEFAULT '',
    "total_cost" TEXT NOT NULL,
    "item_count" INTEGER NOT NULL,
    "items" JSONB NOT NULL,
    "ledger" INTEGER NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bundle_trades_pkey" PRIMARY KEY ("id")
);

-- AlterTable Trade
ALTER TABLE "Trade" ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT 'single';

-- CreateIndex
CREATE UNIQUE INDEX "bundle_trades_ledger_tx_hash_key" ON "bundle_trades"("ledger", "tx_hash");

-- CreateIndex
CREATE INDEX "bundle_trades_wallet_idx" ON "bundle_trades"("wallet");

-- CreateIndex
CREATE INDEX "bundle_trades_buyer_idx" ON "bundle_trades"("buyer");

-- CreateIndex
CREATE INDEX "bundle_trades_ledger_idx" ON "bundle_trades"("ledger");

-- CreateIndex
CREATE INDEX "bundle_trades_timestamp_idx" ON "bundle_trades"("timestamp");
