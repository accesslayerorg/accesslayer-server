-- #936: platform activity feed — new ActivityType enum value
ALTER TYPE "ActivityType" ADD VALUE 'SUPPLY_FULLY_FUNDED';

-- #935: governance proposal quorum escalation tracking
ALTER TABLE "GovernanceProposal" ADD COLUMN     "escalationCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "originalDeadline" TIMESTAMP(3),
ADD COLUMN     "extendedDeadline" TIMESTAMP(3),
ADD COLUMN     "maxEscalations" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "escalatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "GovernanceProposal_escalationCount_status_idx" ON "GovernanceProposal"("escalationCount", "status");

-- CreateTable
CREATE TABLE "GovernanceEscalationEventLog" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "ledger" INTEGER,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GovernanceEscalationEventLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GovernanceEscalationEventLog_txHash_eventIndex_key" ON "GovernanceEscalationEventLog"("txHash", "eventIndex");

-- CreateIndex
CREATE INDEX "GovernanceEscalationEventLog_keyId_proposalId_idx" ON "GovernanceEscalationEventLog"("keyId", "proposalId");

-- #983: key factory deployment event indexing and registry
CREATE TABLE "FactoryDeployedKey" (
    "id" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "creatorWallet" TEXT NOT NULL,
    "keyId" TEXT,
    "deployedAt" TIMESTAMP(3) NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FactoryDeployedKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FactoryDeployedKey_contractAddress_key" ON "FactoryDeployedKey"("contractAddress");

-- CreateIndex
CREATE UNIQUE INDEX "FactoryDeployedKey_txHash_eventIndex_key" ON "FactoryDeployedKey"("txHash", "eventIndex");

-- CreateIndex
CREATE INDEX "FactoryDeployedKey_creatorWallet_idx" ON "FactoryDeployedKey"("creatorWallet");

-- #980: LP position indexing and rewards
CREATE TABLE "LpPosition" (
    "id" TEXT NOT NULL,
    "lpId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "sharePercent" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "accruedRewards" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LpPosition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LpPosition_lpId_key" ON "LpPosition"("lpId");

-- CreateIndex
CREATE INDEX "LpPosition_wallet_idx" ON "LpPosition"("wallet");

-- CreateIndex
CREATE INDEX "LpPosition_keyId_idx" ON "LpPosition"("keyId");

-- CreateTable
CREATE TABLE "LpEventLog" (
    "id" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LpEventLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LpEventLog_txHash_eventIndex_key" ON "LpEventLog"("txHash", "eventIndex");
