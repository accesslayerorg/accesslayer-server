SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- CreateTable
CREATE TABLE "protocol_pause_events" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "protocol_pause_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escape_redemptions" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "amount" DECIMAL(38,7) NOT NULL,
    "ledger" INTEGER NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL,
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "escape_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "protocol_pause_events_txHash_eventIndex_key" ON "protocol_pause_events"("txHash", "eventIndex");

-- CreateIndex
CREATE INDEX "protocol_pause_events_ledger_eventIndex_idx" ON "protocol_pause_events"("ledger" DESC, "eventIndex" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "escape_redemptions_txHash_eventIndex_key" ON "escape_redemptions"("txHash", "eventIndex");

-- CreateIndex
CREATE INDEX "escape_redemptions_keyId_wallet_idx" ON "escape_redemptions"("keyId", "wallet");
