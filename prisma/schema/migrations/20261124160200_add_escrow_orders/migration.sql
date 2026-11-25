CREATE TABLE "escrow_orders" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "lockedAmount" TEXT NOT NULL,
    "limitPrice" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "expiryLedger" INTEGER,
    "createdLedger" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "escrow_orders_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "escrow_orders_wallet_status_idx" ON "escrow_orders"("wallet", "status");
CREATE INDEX "escrow_orders_keyId_status_idx" ON "escrow_orders"("keyId", "status");

CREATE TABLE "escrow_fills" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "keeper" TEXT NOT NULL,
    "fillPrice" TEXT NOT NULL,
    "fillAmount" TEXT NOT NULL,
    "keeperReward" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "escrow_fills_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "escrow_fills_orderId_idx" ON "escrow_fills"("orderId");
CREATE INDEX "escrow_fills_keeper_idx" ON "escrow_fills"("keeper");

ALTER TABLE "escrow_fills" ADD CONSTRAINT "escrow_fills_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "escrow_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
