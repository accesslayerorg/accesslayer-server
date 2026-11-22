-- CreateTable
CREATE TABLE "key_lp_positions" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "lpTokens" DECIMAL(38,7) NOT NULL DEFAULT 0,
    "entryPrice" DECIMAL(38,7) NOT NULL DEFAULT 0,
    "eligibleLpTokens" DECIMAL(38,7) NOT NULL DEFAULT 0,
    "accruedRewards" DECIMAL(38,0) NOT NULL DEFAULT 0,
    "claimedRewards" DECIMAL(38,0) NOT NULL DEFAULT 0,
    "lastDepositAt" TIMESTAMP(3),
    "lastAccruedEpochEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "key_lp_positions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "key_lp_reward_pools" (
    "keyId" TEXT NOT NULL,
    "balance" DECIMAL(38,0) NOT NULL DEFAULT 0,
    "totalFunded" DECIMAL(38,0) NOT NULL DEFAULT 0,
    "totalDistributed" DECIMAL(38,0) NOT NULL DEFAULT 0,
    "lastEpochEnd" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "key_lp_reward_pools_pkey" PRIMARY KEY ("keyId")
);

-- CreateTable
CREATE TABLE "key_lp_reward_epochs" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "epochStart" TIMESTAMP(3) NOT NULL,
    "epochEnd" TIMESTAMP(3) NOT NULL,
    "tradeVolume" DECIMAL(38,0) NOT NULL,
    "lpFeeBps" INTEGER NOT NULL,
    "fundedAmount" DECIMAL(38,0) NOT NULL,
    "poolAmount" DECIMAL(38,0) NOT NULL,
    "distributedAmount" DECIMAL(38,0) NOT NULL,
    "carriedOverAmount" DECIMAL(38,0) NOT NULL,
    "totalEligibleLpTokens" DECIMAL(38,7) NOT NULL,
    "positionCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "key_lp_reward_epochs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "key_lp_reward_accruals" (
    "id" TEXT NOT NULL,
    "epochId" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "eligibleLpTokens" DECIMAL(38,7) NOT NULL,
    "amount" DECIMAL(38,0) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "key_lp_reward_accruals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "key_lp_reward_claims" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "amount" DECIMAL(38,0) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "txHash" TEXT,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "key_lp_reward_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "key_lp_positions_wallet_idx" ON "key_lp_positions"("wallet");

-- CreateIndex
CREATE UNIQUE INDEX "key_lp_positions_keyId_wallet_key" ON "key_lp_positions"("keyId", "wallet");

-- CreateIndex
CREATE INDEX "key_lp_reward_epochs_epochStart_idx" ON "key_lp_reward_epochs"("epochStart");

-- CreateIndex
CREATE UNIQUE INDEX "key_lp_reward_epochs_keyId_epochStart_key" ON "key_lp_reward_epochs"("keyId", "epochStart");

-- CreateIndex
CREATE INDEX "key_lp_reward_accruals_positionId_idx" ON "key_lp_reward_accruals"("positionId");

-- CreateIndex
CREATE UNIQUE INDEX "key_lp_reward_accruals_epochId_positionId_key" ON "key_lp_reward_accruals"("epochId", "positionId");

-- CreateIndex
CREATE INDEX "key_lp_reward_claims_keyId_wallet_createdAt_idx" ON "key_lp_reward_claims"("keyId", "wallet", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "key_lp_reward_claims_status_idx" ON "key_lp_reward_claims"("status");

-- AddForeignKey
ALTER TABLE "key_lp_reward_accruals" ADD CONSTRAINT "key_lp_reward_accruals_epochId_fkey" FOREIGN KEY ("epochId") REFERENCES "key_lp_reward_epochs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "key_lp_reward_accruals" ADD CONSTRAINT "key_lp_reward_accruals_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "key_lp_positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "key_lp_reward_claims" ADD CONSTRAINT "key_lp_reward_claims_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "key_lp_positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

