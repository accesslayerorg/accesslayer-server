-- #1061: Persist indexed key freeze state and its on-chain event history.
CREATE TABLE IF NOT EXISTS "key_freeze_status" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "isFrozen" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "expiryTimestamp" TIMESTAMP(3),
    "frozenAt" TIMESTAMP(3),
    "frozenBy" TEXT,
    "unfrozenAt" TIMESTAMP(3),
    "proposalId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "key_freeze_status_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "key_freeze_status"
    ADD COLUMN IF NOT EXISTS "expiryTimestamp" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "key_freeze_status_keyId_key" ON "key_freeze_status"("keyId");
CREATE INDEX IF NOT EXISTS "key_freeze_status_isFrozen_idx" ON "key_freeze_status"("isFrozen");

CREATE TABLE IF NOT EXISTS "FreezeEvent" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "ledger" BIGINT NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "FreezeEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "FreezeEvent_txHash_eventIndex_key"
    ON "FreezeEvent"("txHash", "eventIndex");
CREATE INDEX IF NOT EXISTS "FreezeEvent_keyId_ledger_idx"
    ON "FreezeEvent"("keyId", "ledger");
CREATE INDEX IF NOT EXISTS "FreezeEvent_ledger_idx" ON "FreezeEvent"("ledger");
