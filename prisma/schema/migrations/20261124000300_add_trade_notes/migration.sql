-- CreateTable
CREATE TABLE "trade_notes" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "keyId" TEXT,
    "body" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trade_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "trade_notes_wallet_txHash_key" ON "trade_notes"("wallet", "txHash");

-- CreateIndex
CREATE INDEX "trade_notes_wallet_updatedAt_idx" ON "trade_notes"("wallet", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "trade_notes_wallet_keyId_idx" ON "trade_notes"("wallet", "keyId");
