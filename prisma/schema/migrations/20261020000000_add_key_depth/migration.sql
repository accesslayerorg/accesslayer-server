-- CreateTable
CREATE TABLE "key_depth" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "price" BIGINT NOT NULL,
    "volume" BIGINT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "key_depth_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "key_depth_side_check" CHECK ("side" IN ('bid', 'ask')),
    CONSTRAINT "key_depth_price_check" CHECK ("price" > 0),
    CONSTRAINT "key_depth_volume_check" CHECK ("volume" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "key_depth_creatorId_side_price_key" ON "key_depth"("creatorId", "side", "price");
