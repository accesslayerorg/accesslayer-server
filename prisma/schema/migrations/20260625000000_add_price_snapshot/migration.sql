-- CreateTable
CREATE TABLE "creator_price_snapshots" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "currentPrice" BIGINT NOT NULL DEFAULT 0,
    "price24hAgo" BIGINT NOT NULL DEFAULT 0,
    "lastTradeAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "creator_price_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "creator_price_snapshots_creatorId_key" ON "creator_price_snapshots"("creatorId");

-- CreateIndex
CREATE INDEX "creator_price_snapshots_creatorId_idx" ON "creator_price_snapshots"("creatorId");

-- AddForeignKey
ALTER TABLE "creator_price_snapshots" ADD CONSTRAINT "creator_price_snapshots_creatorId_fkey"
    FOREIGN KEY ("creatorId") REFERENCES "CreatorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
