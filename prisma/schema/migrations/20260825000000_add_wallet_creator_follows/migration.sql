-- CreateTable
CREATE TABLE "wallet_creator_follows" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_creator_follows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wallet_creator_follows_walletAddress_creatorId_key" ON "wallet_creator_follows"("walletAddress", "creatorId");

-- CreateIndex
CREATE INDEX "wallet_creator_follows_walletAddress_idx" ON "wallet_creator_follows"("walletAddress");

-- CreateIndex
CREATE INDEX "wallet_creator_follows_creatorId_idx" ON "wallet_creator_follows"("creatorId");
