-- Reorg-aware Stellar event ingestion (#724).
--
-- 1. ledger_checkpoints gains ledgerHash/previousLedgerHash so the pipeline
--    can verify that each incoming ledger chains onto the last ingested one
--    and detect ledger rollbacks.
-- 2. New ingested_events table records every ingested event with the ledger
--    sequence and hash it was observed in, so a reorg can mark exactly the
--    affected events as REORGED and reverse their side effects.

-- AlterTable
ALTER TABLE "ledger_checkpoints" ADD COLUMN     "ledgerHash" TEXT,
ADD COLUMN     "previousLedgerHash" TEXT;

-- CreateEnum
CREATE TYPE "IngestedEventStatus" AS ENUM ('CONFIRMED', 'REORGED');

-- CreateTable
CREATE TABLE "ingested_events" (
    "id" TEXT NOT NULL,
    "ledgerSequence" INTEGER NOT NULL,
    "ledgerHash" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "actor" TEXT,
    "creatorId" TEXT,
    "amount" TEXT,
    "priceStroops" TEXT,
    "tradeAt" TIMESTAMP(3),
    "status" "IngestedEventStatus" NOT NULL DEFAULT 'CONFIRMED',
    "reorgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ingested_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ingested_events_txHash_eventIndex_key" ON "ingested_events"("txHash", "eventIndex");

-- CreateIndex
CREATE INDEX "ingested_events_ledgerSequence_idx" ON "ingested_events"("ledgerSequence");

-- CreateIndex
CREATE INDEX "ingested_events_status_idx" ON "ingested_events"("status");

-- CreateIndex
CREATE INDEX "ingested_events_creatorId_idx" ON "ingested_events"("creatorId");
