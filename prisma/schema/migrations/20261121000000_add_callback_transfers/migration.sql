-- Migration: add callback_transfers — transfers whose execution invoked a
-- callback on a contract (#1274). Idempotent writes via skipDuplicates;
-- @@unique([txHash, eventIndex]) dedupes replays.

CREATE TABLE "CallbackTransfer" (
    id TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "toContract" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    amount TEXT NOT NULL,
    "dataHash" TEXT NOT NULL,
    ledger INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CallbackTransfer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CallbackTransfer_txHash_eventIndex_key" ON "CallbackTransfer"("txHash", "eventIndex");
