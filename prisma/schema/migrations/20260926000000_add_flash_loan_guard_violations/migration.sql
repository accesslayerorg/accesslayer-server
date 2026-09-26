-- Flash loan guard violation tracking (#938).
-- The indexer writes one flash_loan_violations row per
-- FlashLoanGuardTriggered contract event; flash_loan_guard_statuses holds the
-- per-wallet frequency, alert and auto-suspension state.
CREATE TABLE "flash_loan_violations" (
    "id"            TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "keyId"         TEXT,
    "ledger"        INTEGER NOT NULL,
    "txHash"        TEXT NOT NULL,
    "eventIndex"    INTEGER NOT NULL,
    "occurredAt"    TIMESTAMP(3) NOT NULL,
    "clearedAt"     TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flash_loan_violations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "flash_loan_guard_statuses" (
    "id"                        TEXT NOT NULL,
    "walletAddress"             TEXT NOT NULL,
    "violationCount"            INTEGER NOT NULL DEFAULT 0,
    "lastViolationAt"           TIMESTAMP(3),
    "alertedAt"                 TIMESTAMP(3),
    "alertCount"                INTEGER NOT NULL DEFAULT 0,
    "lastAlertedViolationCount" INTEGER NOT NULL DEFAULT 0,
    "autoSuspended"             BOOLEAN NOT NULL DEFAULT false,
    "suspendedAt"               TIMESTAMP(3),
    "suspensionExpiresAt"       TIMESTAMP(3),
    "liftedAt"                  TIMESTAMP(3),
    "liftedBy"                  TEXT,
    "createdAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"                 TIMESTAMP(3) NOT NULL,

    CONSTRAINT "flash_loan_guard_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "flash_loan_violations_txHash_eventIndex_key" ON "flash_loan_violations"("txHash", "eventIndex");

-- CreateIndex
CREATE INDEX "flash_loan_violations_walletAddress_occurredAt_idx" ON "flash_loan_violations"("walletAddress", "occurredAt");

-- CreateIndex
CREATE INDEX "flash_loan_violations_occurredAt_idx" ON "flash_loan_violations"("occurredAt");

-- CreateIndex
CREATE INDEX "flash_loan_violations_clearedAt_idx" ON "flash_loan_violations"("clearedAt");

-- CreateIndex
CREATE UNIQUE INDEX "flash_loan_guard_statuses_walletAddress_key" ON "flash_loan_guard_statuses"("walletAddress");

-- CreateIndex
CREATE INDEX "flash_loan_guard_statuses_violationCount_idx" ON "flash_loan_guard_statuses"("violationCount");

-- CreateIndex
CREATE INDEX "flash_loan_guard_statuses_alertedAt_idx" ON "flash_loan_guard_statuses"("alertedAt");

-- CreateIndex
CREATE INDEX "flash_loan_guard_statuses_suspendedAt_idx" ON "flash_loan_guard_statuses"("suspendedAt");
