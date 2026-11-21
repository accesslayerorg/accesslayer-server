-- Staking reward multiplier tiers and positions (#942)
CREATE TABLE "staking_multiplier_tiers" (
    "id" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "name" TEXT,
    "lockPeriodSeconds" INTEGER NOT NULL,
    "multiplier" DECIMAL(10,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staking_multiplier_tiers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "staking_multiplier_tiers_tier_key" ON "staking_multiplier_tiers"("tier");

CREATE TABLE "staking_positions" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "keyId" TEXT,
    "amount" DECIMAL(20,7) NOT NULL,
    "lockPeriodSeconds" INTEGER NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unlocksAt" TIMESTAMP(3),
    "tier" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staking_positions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "staking_positions_wallet_idx" ON "staking_positions"("wallet");
CREATE INDEX "staking_positions_keyId_idx" ON "staking_positions"("keyId");
