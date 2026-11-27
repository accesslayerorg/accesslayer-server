-- CreateEnum
CREATE TYPE "PendingFeeChangeStatus" AS ENUM ('PENDING', 'EXECUTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "fee_config_history" (
    "id" TEXT NOT NULL,
    "protocolFeeBps" INTEGER NOT NULL,
    "creatorFeeBps" INTEGER,
    "feeTiers" JSONB,
    "effectiveLedger" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fee_config_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pending_fee_changes" (
    "id" TEXT NOT NULL,
    "changeId" TEXT,
    "protocolFeeBps" INTEGER NOT NULL,
    "creatorFeeBps" INTEGER,
    "feeTiers" JSONB,
    "queuedLedger" INTEGER NOT NULL,
    "executeAfterLedger" INTEGER NOT NULL,
    "estimatedExecuteAt" TIMESTAMP(3),
    "status" "PendingFeeChangeStatus" NOT NULL DEFAULT 'PENDING',
    "queuedTxHash" TEXT NOT NULL,
    "queuedEventIndex" INTEGER NOT NULL,
    "resolvedTxHash" TEXT,
    "resolvedEventIndex" INTEGER,
    "resolvedLedger" INTEGER,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pending_fee_changes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fee_config_history_txHash_eventIndex_key" ON "fee_config_history"("txHash", "eventIndex");

-- CreateIndex
CREATE INDEX "fee_config_history_effectiveLedger_idx" ON "fee_config_history"("effectiveLedger" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "pending_fee_changes_changeId_key" ON "pending_fee_changes"("changeId");

-- CreateIndex
CREATE UNIQUE INDEX "pending_fee_changes_queuedTxHash_queuedEventIndex_key" ON "pending_fee_changes"("queuedTxHash", "queuedEventIndex");

-- CreateIndex
CREATE UNIQUE INDEX "pending_fee_changes_resolvedTxHash_resolvedEventIndex_key" ON "pending_fee_changes"("resolvedTxHash", "resolvedEventIndex");

-- CreateIndex
CREATE INDEX "pending_fee_changes_status_queuedLedger_idx" ON "pending_fee_changes"("status", "queuedLedger" DESC);
