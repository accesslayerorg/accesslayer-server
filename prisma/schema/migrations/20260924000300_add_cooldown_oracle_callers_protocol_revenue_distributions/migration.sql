-- Buy cooldown status (#874)
ALTER TABLE "CreatorProfile"
ADD COLUMN "cooldownLedgers" INTEGER NOT NULL DEFAULT 0;

-- Oracle approved callers (#873)
CREATE TABLE "OracleCaller" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "addedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OracleCaller_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OracleCaller_address_key" ON "OracleCaller"("address");

-- Protocol revenue distributions (#875)
CREATE TABLE "ProtocolRevenueDistribution" (
    "id" TEXT NOT NULL,
    "distributionId" TEXT NOT NULL,
    "totalDistributed" DECIMAL(20,7) NOT NULL,
    "stakerCount" INTEGER NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "distributedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProtocolRevenueDistribution_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProtocolRevenueDistribution_distributionId_key" ON "ProtocolRevenueDistribution"("distributionId");
CREATE UNIQUE INDEX "ProtocolRevenueDistribution_ledger_txHash_key" ON "ProtocolRevenueDistribution"("ledger", "txHash");
CREATE INDEX "ProtocolRevenueDistribution_distributedAt_idx" ON "ProtocolRevenueDistribution"("distributedAt" DESC);

CREATE TABLE "ProtocolRevenueShare" (
    "id" TEXT NOT NULL,
    "distributionId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "amount" DECIMAL(20,7) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProtocolRevenueShare_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProtocolRevenueShare_distributionId_fkey" FOREIGN KEY ("distributionId")
      REFERENCES "ProtocolRevenueDistribution"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ProtocolRevenueShare_distributionId_wallet_key" ON "ProtocolRevenueShare"("distributionId", "wallet");
CREATE INDEX "ProtocolRevenueShare_wallet_idx" ON "ProtocolRevenueShare"("wallet");
