-- Migration: add_trade_payment_asset (#934)
--
-- Adds paymentAsset to the Trade table to track which asset was used
-- for each key purchase. Existing rows default to 'XLM'.
-- Adds targeted indexes for aggregation queries.

ALTER TABLE "Trade"
  ADD COLUMN "paymentAsset" TEXT NOT NULL DEFAULT 'XLM';

CREATE INDEX "Trade_paymentAsset_idx"          ON "Trade" ("paymentAsset");
CREATE INDEX "Trade_creatorId_paymentAsset_idx" ON "Trade" ("creatorId", "paymentAsset");
