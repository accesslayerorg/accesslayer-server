-- Realized gains (#1218): per-wallet, per-key chronological trade scans.
-- Trade.buyer is the wallet, Trade.creatorId the key and Trade.timestamp the
-- execution time.
CREATE INDEX "Trade_buyer_creatorId_timestamp_idx" ON "Trade" ("buyer", "creatorId", "timestamp");
