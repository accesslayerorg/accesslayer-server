-- CreateTable
CREATE TABLE "pass_events" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "creatorWallet" TEXT NOT NULL,
    "title" TEXT,
    "startLedger" INTEGER NOT NULL,
    "endLedger" INTEGER NOT NULL,
    "capacity" INTEGER NOT NULL,
    "redeemedCount" INTEGER NOT NULL DEFAULT 0,
    "minBalance" DECIMAL(36,7) NOT NULL DEFAULT 1,
    "closed" BOOLEAN NOT NULL DEFAULT false,
    "createdTxHash" TEXT NOT NULL,
    "createdEventIndex" INTEGER NOT NULL,
    "closedTxHash" TEXT,
    "closedEventIndex" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pass_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pass_redemptions" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "ledger" INTEGER NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pass_redemptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pass_events_createdTxHash_createdEventIndex_key" ON "pass_events"("createdTxHash", "createdEventIndex");
CREATE INDEX "pass_events_keyId_startLedger_idx" ON "pass_events"("keyId", "startLedger");

-- CreateIndex
CREATE UNIQUE INDEX "pass_redemptions_txHash_eventIndex_key" ON "pass_redemptions"("txHash", "eventIndex");
CREATE UNIQUE INDEX "pass_redemptions_eventId_wallet_key" ON "pass_redemptions"("eventId", "wallet");
CREATE INDEX "pass_redemptions_eventId_ledger_id_idx" ON "pass_redemptions"("eventId", "ledger" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "pass_redemptions" ADD CONSTRAINT "pass_redemptions_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "pass_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
