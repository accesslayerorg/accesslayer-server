-- Auto-invest rule management and execution (issue #1031).
--
-- Adds category and rating to CreatorProfile so auto-invest rules can match
-- newly listed keys against category, minimum rating, and maximum price.
-- Creates the AutoInvestRule and AutoInvestExecution tables. The execution
-- table's unique (ruleId, listingId) constraint is the idempotency key that
-- prevents duplicate purchases for the same rule and listing.

-- 1. Category and rating on creator keys.
ALTER TABLE "CreatorProfile" ADD COLUMN "category" TEXT;
ALTER TABLE "CreatorProfile" ADD COLUMN "rating" DECIMAL(3,2);

-- 2. Auto-invest rules, owned by a Stellar wallet address.
CREATE TABLE "AutoInvestRule" (
    "id"            TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "category"      TEXT NOT NULL,
    "minRating"     DECIMAL(3,2),
    "maxPrice"      DECIMAL(20,7) NOT NULL,
    "maxPerKey"     INTEGER NOT NULL DEFAULT 1,
    "isActive"      BOOLEAN NOT NULL DEFAULT true,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"     TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoInvestRule_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AutoInvestRule_walletAddress_idx" ON "AutoInvestRule"("walletAddress");
CREATE INDEX "AutoInvestRule_walletAddress_isActive_idx" ON "AutoInvestRule"("walletAddress", "isActive");

-- 3. Auto-invest execution records (idempotency key: ruleId + listingId).
CREATE TABLE "AutoInvestExecution" (
    "id"             TEXT NOT NULL,
    "ruleId"         TEXT NOT NULL,
    "listingId"      TEXT NOT NULL,
    "status"         TEXT NOT NULL DEFAULT 'PENDING',
    "transactionHash" TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutoInvestExecution_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AutoInvestExecution_ruleId_listingId_key" ON "AutoInvestExecution"("ruleId", "listingId");
CREATE INDEX "AutoInvestExecution_ruleId_idx" ON "AutoInvestExecution"("ruleId");
CREATE INDEX "AutoInvestExecution_listingId_idx" ON "AutoInvestExecution"("listingId");
