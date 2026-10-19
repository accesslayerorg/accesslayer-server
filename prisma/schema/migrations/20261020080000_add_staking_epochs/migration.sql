-- CreateTable
CREATE TABLE "stakes" (
    "id" TEXT NOT NULL,
    "stakeId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "amount" DECIMAL(20,7) NOT NULL,
    "startEpoch" INTEGER NOT NULL DEFAULT 0,
    "lockEpochs" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'active',
    "totalClaimed" DECIMAL(20,7) NOT NULL DEFAULT 0,
    "claimedAt" TIMESTAMP(3),
    "unstakedAt" TIMESTAMP(3),
    "txHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stakes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "epoch_rewards" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "totalDistributed" DECIMAL(20,7) NOT NULL,
    "rewardPerToken" DECIMAL(20,7) NOT NULL DEFAULT 0,
    "txHash" TEXT,
    "distributedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "epoch_rewards_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stakes_stakeId_key" ON "stakes"("stakeId");

-- CreateIndex
CREATE INDEX "stakes_wallet_status_idx" ON "stakes"("wallet", "status");

-- CreateIndex
CREATE INDEX "stakes_keyId_idx" ON "stakes"("keyId");

-- CreateIndex
CREATE UNIQUE INDEX "epoch_rewards_keyId_epoch_key" ON "epoch_rewards"("keyId", "epoch");

-- CreateIndex
CREATE INDEX "epoch_rewards_keyId_epoch_idx" ON "epoch_rewards"("keyId", "epoch" DESC);
