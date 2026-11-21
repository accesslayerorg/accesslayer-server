ALTER TABLE "CreatorProfile"
ADD COLUMN "tradingPaused" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "circulatingSupply" DECIMAL NOT NULL DEFAULT 0;

CREATE TABLE "PendingKeyPurchase" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "buyerAddress" TEXT NOT NULL,
    "memo" TEXT NOT NULL,
    "quantity" DECIMAL NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "transactionHash" TEXT,
    "settledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingKeyPurchase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PendingKeyPurchase_memo_key" ON "PendingKeyPurchase"("memo");
CREATE INDEX "PendingKeyPurchase_creatorId_status_idx" ON "PendingKeyPurchase"("creatorId", "status");
CREATE INDEX "PendingKeyPurchase_buyerAddress_status_idx" ON "PendingKeyPurchase"("buyerAddress", "status");

ALTER TABLE "PendingKeyPurchase"
ADD CONSTRAINT "PendingKeyPurchase_creatorId_fkey"
FOREIGN KEY ("creatorId") REFERENCES "CreatorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
