-- Add the trade direction and circulating supply to price history rows, and an
-- index on recordedAt for the retention job.
--
-- Existing rows keep the column defaults: `supply = 0` (the indexer did not
-- record supply before this change) and `direction = 'BUY'`. They are left as
-- estimates rather than deleted, so historical windows stay continuous.

CREATE TYPE "TradeDirection" AS ENUM ('BUY', 'SELL');

ALTER TABLE "creator_price_history"
  ADD COLUMN "supply" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "direction" "TradeDirection" NOT NULL DEFAULT 'BUY';

CREATE INDEX "creator_price_history_recordedAt_idx"
  ON "creator_price_history" ("recordedAt");
