CREATE TABLE "curve_updates" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "proposedParams" JSONB NOT NULL,
    "eta" TIMESTAMP(3) NOT NULL,
    "proposedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "outcome" TEXT,
    "proposedTxHash" TEXT NOT NULL,
    "proposedEventIndex" INTEGER NOT NULL,
    "executedTxHash" TEXT,
    "executedEventIndex" INTEGER,
    "ledger" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "curve_updates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "curve_updates_keyId_proposalId_key" ON "curve_updates"("keyId", "proposalId");
CREATE UNIQUE INDEX "curve_updates_proposedTxHash_proposedEventIndex_key" ON "curve_updates"("proposedTxHash", "proposedEventIndex");
CREATE UNIQUE INDEX "curve_updates_executedTxHash_executedEventIndex_key" ON "curve_updates"("executedTxHash", "executedEventIndex");
CREATE INDEX "curve_updates_keyId_status_eta_idx" ON "curve_updates"("keyId", "status", "eta");
