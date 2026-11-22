CREATE TABLE "GovernanceEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "target" TEXT,
    "payload" JSONB NOT NULL,
    "ledger" INTEGER,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GovernanceEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GovernanceEvent_txHash_eventIndex_key" ON "GovernanceEvent"("txHash", "eventIndex");
CREATE INDEX "GovernanceEvent_type_ledger_idx" ON "GovernanceEvent"("type", "ledger");
CREATE INDEX "GovernanceEvent_createdAt_idx" ON "GovernanceEvent"("createdAt");
