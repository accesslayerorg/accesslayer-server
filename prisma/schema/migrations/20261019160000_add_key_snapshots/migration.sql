-- CreateTable
CREATE TABLE "key_snapshots" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "price" DECIMAL(20,7) NOT NULL,
    "volume" DECIMAL(20,7) NOT NULL,
    "holderCount" INTEGER NOT NULL,
    "marketCap" DECIMAL(20,7) NOT NULL,
    "txHash" TEXT,
    "blockNumber" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "key_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "key_snapshots_keyId_date_idx" ON "key_snapshots"("keyId", "date" DESC);
