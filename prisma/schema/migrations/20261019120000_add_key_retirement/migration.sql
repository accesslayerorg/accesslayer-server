CREATE TABLE "key_retirement" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "buybackPrice" DECIMAL(36,7),
    "noticeExpiry" TIMESTAMP(3),
    "reason" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "ledger" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "key_retirement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "key_retirement_txHash_eventIndex_key" ON "key_retirement"("txHash", "eventIndex");
CREATE INDEX "key_retirement_keyId_occurredAt_idx" ON "key_retirement"("keyId", "occurredAt" DESC);
