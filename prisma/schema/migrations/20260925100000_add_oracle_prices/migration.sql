-- Oracle price feed read model for GET /keys/:id/oracle-price.
-- The indexer upserts one row per creator on every OraclePriceUpdated
-- contract event so the API can serve oracle price without an RPC round-trip.
CREATE TABLE "oracle_prices" (
    "id"        TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "price"     BIGINT NOT NULL,
    "ledger"    INTEGER NOT NULL,
    "txHash"    TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "eventAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oracle_prices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "oracle_prices_creatorId_key" ON "oracle_prices"("creatorId");
CREATE INDEX "oracle_prices_creatorId_idx" ON "oracle_prices"("creatorId");
CREATE INDEX "oracle_prices_eventAt_idx" ON "oracle_prices"("eventAt");
