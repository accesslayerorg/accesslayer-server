CREATE TABLE "conviction_stakes" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "amount" BIGINT NOT NULL DEFAULT 0,
    "stakedAtLedger" INTEGER NOT NULL,
    "unstakedAtLedger" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "conviction_stakes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "conviction_stakes_proposalId_wallet_key" ON "conviction_stakes"("proposalId", "wallet");
CREATE INDEX "conviction_stakes_proposalId_isActive_idx" ON "conviction_stakes"("proposalId", "isActive");
CREATE INDEX "conviction_stakes_keyId_wallet_idx" ON "conviction_stakes"("keyId", "wallet");

CREATE TABLE "conviction_snapshots" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "totalStaked" BIGINT NOT NULL DEFAULT 0,
    "conviction" BIGINT NOT NULL DEFAULT 0,
    "threshold" BIGINT NOT NULL DEFAULT 0,
    "executed" BOOLEAN NOT NULL DEFAULT false,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "conviction_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "conviction_snapshots_txHash_eventIndex_key" ON "conviction_snapshots"("txHash", "eventIndex");
CREATE INDEX "conviction_snapshots_proposalId_ledger_idx" ON "conviction_snapshots"("proposalId", "ledger");

CREATE TABLE "ragequit_exits" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ragequit_exits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ragequit_exits_txHash_eventIndex_key" ON "ragequit_exits"("txHash", "eventIndex");
CREATE UNIQUE INDEX "ragequit_exits_proposalId_wallet_key" ON "ragequit_exits"("proposalId", "wallet");
CREATE INDEX "ragequit_exits_proposalId_idx" ON "ragequit_exits"("proposalId");
