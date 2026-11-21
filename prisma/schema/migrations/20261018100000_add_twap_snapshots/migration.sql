-- CreateTable
CREATE TABLE "twap_snapshots" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "window" TEXT NOT NULL,
    "twapPrice" BIGINT NOT NULL,
    "observationCount" INTEGER NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL,
    "ledger" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "twap_snapshots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "twap_snapshots_window_check" CHECK ("window" IN ('1h', '4h', '24h')),
    CONSTRAINT "twap_snapshots_twapPrice_check" CHECK ("twapPrice" >= 0),
    CONSTRAINT "twap_snapshots_observationCount_check" CHECK ("observationCount" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "twap_snapshots_txHash_eventIndex_key" ON "twap_snapshots"("txHash", "eventIndex");

-- CreateIndex
CREATE INDEX "twap_snapshots_creatorId_window_computedAt_idx" ON "twap_snapshots"("creatorId", "window", "computedAt" DESC);

-- CreateIndex
CREATE INDEX "twap_snapshots_ledger_idx" ON "twap_snapshots"("ledger");
