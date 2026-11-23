CREATE TABLE "dutch_auctions" (
    "id" TEXT NOT NULL,
    "seller" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "remaining" INTEGER NOT NULL,
    "startPrice" DECIMAL(36,7) NOT NULL,
    "floorPrice" DECIMAL(36,7) NOT NULL,
    "startLedger" INTEGER NOT NULL,
    "durationLedgers" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "fillCount" INTEGER NOT NULL DEFAULT 0,
    "startTxHash" TEXT NOT NULL,
    "startEventIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dutch_auctions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "dutch_auction_fills" (
    "id" TEXT NOT NULL,
    "auctionId" TEXT NOT NULL,
    "buyer" TEXT,
    "quantity" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "ledger" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dutch_auction_fills_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "dutch_auctions_keyId_status_startLedger_idx" ON "dutch_auctions"("keyId", "status", "startLedger" DESC);
CREATE INDEX "dutch_auctions_status_startLedger_idx" ON "dutch_auctions"("status", "startLedger" DESC);
CREATE UNIQUE INDEX "dutch_auction_fills_txHash_eventIndex_key" ON "dutch_auction_fills"("txHash", "eventIndex");
CREATE INDEX "dutch_auction_fills_auctionId_ledger_idx" ON "dutch_auction_fills"("auctionId", "ledger");

ALTER TABLE "dutch_auction_fills" ADD CONSTRAINT "dutch_auction_fills_auctionId_fkey" FOREIGN KEY ("auctionId") REFERENCES "dutch_auctions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
