-- CreateTable
CREATE TABLE "key_auctions" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "auctionId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "reservePrice" DECIMAL(20,7) NOT NULL,
    "highestBid" DECIMAL(20,7),
    "highestBidder" TEXT,
    "clearingPrice" DECIMAL(20,7),
    "startTime" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endTime" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "winner" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "key_auctions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "key_auction_bids" (
    "id" TEXT NOT NULL,
    "auctionId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "bidder" TEXT NOT NULL,
    "amount" DECIMAL(20,7) NOT NULL,
    "txHash" TEXT,
    "blockNumber" BIGINT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "key_auction_bids_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "key_auctions_keyId_key" ON "key_auctions"("keyId");

-- CreateIndex
CREATE UNIQUE INDEX "key_auctions_auctionId_key" ON "key_auctions"("auctionId");

-- CreateIndex
CREATE INDEX "key_auctions_keyId_status_idx" ON "key_auctions"("keyId", "status");

-- CreateIndex
CREATE INDEX "key_auctions_status_endTime_idx" ON "key_auctions"("status", "endTime");

-- CreateIndex
CREATE INDEX "key_auction_bids_auctionId_amount_idx" ON "key_auction_bids"("auctionId", "amount" DESC);

-- CreateIndex
CREATE INDEX "key_auction_bids_keyId_timestamp_idx" ON "key_auction_bids"("keyId", "timestamp" DESC);

-- AddForeignKey
ALTER TABLE "key_auction_bids" ADD CONSTRAINT "key_auction_bids_auctionId_fkey" FOREIGN KEY ("auctionId") REFERENCES "key_auctions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
