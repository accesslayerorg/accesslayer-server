-- Staking vault positions synced from VaultDeposit / VaultWithdraw events
CREATE TABLE "VaultPosition" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "quantity" DECIMAL(20,7) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VaultPosition_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VaultPosition_wallet_creatorId_key" ON "VaultPosition"("wallet", "creatorId");
CREATE INDEX "VaultPosition_wallet_idx" ON "VaultPosition"("wallet");
CREATE INDEX "VaultPosition_creatorId_idx" ON "VaultPosition"("creatorId");

CREATE TABLE "VaultEventLog" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "quantity" DECIMAL(20,7) NOT NULL,
    "ledger" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VaultEventLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VaultEventLog_txHash_eventIndex_key" ON "VaultEventLog"("txHash", "eventIndex");
CREATE INDEX "VaultEventLog_ledger_idx" ON "VaultEventLog"("ledger");
