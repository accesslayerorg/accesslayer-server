-- CreateTable
CREATE TABLE "trade_hourly_stats" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "trades" INTEGER NOT NULL DEFAULT 0,
    "volume" DECIMAL(20,7) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trade_hourly_stats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trade_hourly_stats_keyId_bucketStart_key" ON "trade_hourly_stats"("keyId", "bucketStart");

-- CreateIndex
CREATE INDEX "trade_hourly_stats_keyId_bucketStart_idx" ON "trade_hourly_stats"("keyId", "bucketStart");
