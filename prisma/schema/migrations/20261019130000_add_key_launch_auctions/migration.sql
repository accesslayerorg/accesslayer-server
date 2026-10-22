CREATE TABLE "key_auctions" (
    "id" TEXT NOT NULL,
    "auctionId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "reserve" DECIMAL(36,7) NOT NULL,
    "highestBid" DECIMAL(36,7),
    "highestBidder" TEXT,
    "clearingPrice" DECIMAL(36,7),
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "createdTxHash" TEXT NOT NULL,
    "createdEventIndex" INTEGER NOT NULL,
    "settledTxHash" TEXT,
    "settledEventIndex" INTEGER,
    "ledger" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "key_auctions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "key_auction_bids" (
    "id" TEXT NOT NULL,
    "auctionId" TEXT NOT NULL,
    "bidder" TEXT NOT NULL,
    "amount" DECIMAL(36,7) NOT NULL,
    "placedAt" TIMESTAMP(3) NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "ledger" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "key_auction_bids_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "key_auctions_auctionId_key" ON "key_auctions"("auctionId");
CREATE UNIQUE INDEX "key_auctions_keyId_key" ON "key_auctions"("keyId");
CREATE UNIQUE INDEX "key_auctions_createdTxHash_createdEventIndex_key" ON "key_auctions"("createdTxHash", "createdEventIndex");
CREATE UNIQUE INDEX "key_auctions_settledTxHash_settledEventIndex_key" ON "key_auctions"("settledTxHash", "settledEventIndex");
CREATE INDEX "key_auctions_keyId_status_idx" ON "key_auctions"("keyId", "status");
CREATE UNIQUE INDEX "key_auction_bids_txHash_eventIndex_key" ON "key_auction_bids"("txHash", "eventIndex");
CREATE INDEX "key_auction_bids_auctionId_placedAt_idx" ON "key_auction_bids"("auctionId", "placedAt" DESC);
ALTER TABLE "key_auction_bids" ADD CONSTRAINT "key_auction_bids_auctionId_fkey" FOREIGN KEY ("auctionId") REFERENCES "key_auctions"("auctionId") ON DELETE CASCADE ON UPDATE CASCADE;
