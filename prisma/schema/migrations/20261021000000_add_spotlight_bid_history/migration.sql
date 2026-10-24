CREATE TABLE "SpotlightBidEvent" (
  "id" TEXT NOT NULL,
  "keyId" TEXT NOT NULL,
  "bidder" TEXT NOT NULL,
  "amount" DECIMAL(30,7) NOT NULL,
  "eventType" TEXT NOT NULL,
  "txHash" TEXT NOT NULL,
  "eventIndex" INTEGER NOT NULL,
  "ledger" INTEGER NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SpotlightBidEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SpotlightBidEvent_txHash_eventIndex_key" ON "SpotlightBidEvent"("txHash", "eventIndex");
CREATE INDEX "SpotlightBidEvent_keyId_occurredAt_idx" ON "SpotlightBidEvent"("keyId", "occurredAt" DESC);
CREATE INDEX "SpotlightBidEvent_bidder_occurredAt_idx" ON "SpotlightBidEvent"("bidder", "occurredAt" DESC);
