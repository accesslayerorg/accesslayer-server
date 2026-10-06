-- #893: Price snapshot recording service for TWAP and analytics
-- Adds trade direction and post-trade circulating supply to every recorded
-- price snapshot, so GET /keys/:id/price-history can serve TWAP inputs and
-- historical charts without a second query.

-- CreateEnum
CREATE TYPE "PriceSnapshotDirection" AS ENUM ('BUY', 'SELL');

-- AlterTable
ALTER TABLE "creator_price_history"
   ADD COLUMN "supply" BIGINT NOT NULL DEFAULT 0,
   ADD COLUMN "direction" "PriceSnapshotDirection" NOT NULL DEFAULT 'BUY';

-- Composite index on key ID + timestamp for fast range queries (idempotent:
-- only created if a prior deploy hasn't already added it via `prisma db push`).
CREATE INDEX IF NOT EXISTS "creator_price_history_creatorId_recordedAt_idx"
   ON "creator_price_history" ("creatorId", "recordedAt");
