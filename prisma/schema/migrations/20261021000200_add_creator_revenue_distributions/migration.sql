CREATE TABLE "revenue_distributions" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "chainDistributionId" TEXT,
    "amount" DECIMAL(20,7) NOT NULL,
    "holderCount" INTEGER NOT NULL,
    "ledger" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL DEFAULT 0,
    "distributedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_distributions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "revenue_distributions_ledger_txHash_eventIndex_key"
    ON "revenue_distributions"("ledger", "txHash", "eventIndex");
CREATE UNIQUE INDEX "revenue_distributions_keyId_chainDistributionId_key"
    ON "revenue_distributions"("keyId", "chainDistributionId");
CREATE INDEX "revenue_distributions_keyId_distributedAt_id_idx"
    ON "revenue_distributions"("keyId", "distributedAt" DESC, "id" DESC);

CREATE TABLE "revenue_distribution_shares" (
    "id" TEXT NOT NULL,
    "distributionId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "amount" DECIMAL(20,7) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_distribution_shares_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "revenue_distribution_shares_distributionId_fkey"
        FOREIGN KEY ("distributionId") REFERENCES "revenue_distributions"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "revenue_distribution_shares_distributionId_wallet_key"
    ON "revenue_distribution_shares"("distributionId", "wallet");
CREATE INDEX "revenue_distribution_shares_wallet_idx"
    ON "revenue_distribution_shares"("wallet");

CREATE TABLE "revenue_share_claims" (
    "id" TEXT NOT NULL,
    "distributionId" TEXT NOT NULL,
    "shareId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "amount" DECIMAL(20,7) NOT NULL,
    "ledger" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_share_claims_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "revenue_share_claims_distributionId_fkey"
        FOREIGN KEY ("distributionId") REFERENCES "revenue_distributions"("id")
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "revenue_share_claims_shareId_fkey"
        FOREIGN KEY ("shareId") REFERENCES "revenue_distribution_shares"("id")
        ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "revenue_share_claims_ledger_txHash_eventIndex_key"
    ON "revenue_share_claims"("ledger", "txHash", "eventIndex");
CREATE INDEX "revenue_share_claims_distributionId_wallet_idx"
    ON "revenue_share_claims"("distributionId", "wallet");
