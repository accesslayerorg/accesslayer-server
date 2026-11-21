-- Create DividendDistribution table
CREATE TABLE "DividendDistribution" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "distributionDate" TIMESTAMP(3) NOT NULL,
    "totalAmountXlm" NUMERIC(20,7) NOT NULL,
    "holderCount" INTEGER NOT NULL,
    "perKeyAmountXlm" NUMERIC(20,7) NOT NULL,
    "ledger" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DividendDistribution_pkey" PRIMARY KEY ("id")
);

-- Create DividendClaim table
CREATE TABLE "DividendClaim" (
    "id" TEXT NOT NULL,
    "distributionId" TEXT NOT NULL,
    "recipientAddress" TEXT NOT NULL,
    "amountXlm" NUMERIC(20,7) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DividendClaim_pkey" PRIMARY KEY ("id")
);

-- Add unique constraints
ALTER TABLE "DividendDistribution" ADD CONSTRAINT "DividendDistribution_ledger_txHash_key" UNIQUE("ledger", "txHash");
ALTER TABLE "DividendClaim" ADD CONSTRAINT "DividendClaim_distributionId_recipientAddress_key" UNIQUE("distributionId", "recipientAddress");

-- Add indexes for efficient querying
CREATE INDEX "DividendDistribution_creatorId_idx" ON "DividendDistribution"("creatorId");
CREATE INDEX "DividendDistribution_distributionDate_idx" ON "DividendDistribution"("distributionDate" DESC);
CREATE INDEX "DividendClaim_recipientAddress_idx" ON "DividendClaim"("recipientAddress");
CREATE INDEX "DividendClaim_distributionId_idx" ON "DividendClaim"("distributionId");

-- Add foreign key constraint
ALTER TABLE "DividendClaim" ADD CONSTRAINT "DividendClaim_distributionId_fkey" FOREIGN KEY ("distributionId") REFERENCES "DividendDistribution"("id") ON DELETE CASCADE;
