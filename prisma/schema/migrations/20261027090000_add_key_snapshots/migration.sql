-- CreateTable
CREATE TABLE "key_snapshots" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "snapshotDate" DATE NOT NULL,
    "price" BIGINT NOT NULL,
    "volume" BIGINT NOT NULL,
    "holderCount" INTEGER NOT NULL,
    "marketCap" BIGINT NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL,
    "ledger" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "key_snapshots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "key_snapshots_price_check" CHECK ("price" >= 0),
    CONSTRAINT "key_snapshots_volume_check" CHECK ("volume" >= 0),
    CONSTRAINT "key_snapshots_holderCount_check" CHECK ("holderCount" >= 0),
    CONSTRAINT "key_snapshots_marketCap_check" CHECK ("marketCap" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "key_snapshots_creatorId_snapshotDate_key" ON "key_snapshots"("creatorId", "snapshotDate");

-- CreateIndex
CREATE INDEX "key_snapshots_ledger_idx" ON "key_snapshots"("ledger");
