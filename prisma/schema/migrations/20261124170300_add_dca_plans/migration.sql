CREATE TABLE "dca_plans" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "frequency" TEXT NOT NULL,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "budgetRemaining" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "maxSlippageBps" INTEGER NOT NULL DEFAULT 100,
    "spendingAuth" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "dca_plans_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "dca_plans_wallet_status_idx" ON "dca_plans"("wallet", "status");
CREATE INDEX "dca_plans_status_nextRunAt_idx" ON "dca_plans"("status", "nextRunAt");

CREATE TABLE "dca_runs" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "amountSpent" BIGINT,
    "txHash" TEXT,
    "txXdr" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "dca_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dca_runs_planId_scheduledFor_key" ON "dca_runs"("planId", "scheduledFor");
CREATE INDEX "dca_runs_planId_createdAt_idx" ON "dca_runs"("planId", "createdAt");

ALTER TABLE "dca_runs" ADD CONSTRAINT "dca_runs_planId_fkey"
    FOREIGN KEY ("planId") REFERENCES "dca_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
