-- Protocol fee singleton
CREATE TABLE "protocol_config" (
    "id" TEXT NOT NULL,
    "protocolFeeBps" INTEGER NOT NULL DEFAULT 500,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "protocol_config_pkey" PRIMARY KEY ("id")
);

INSERT INTO "protocol_config" ("id", "protocolFeeBps", "updatedAt", "createdAt")
VALUES ('default', 500, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Creator royalty BPS on key (CreatorProfile) records
ALTER TABLE "CreatorProfile"
ADD COLUMN "creatorRoyaltyBuyBps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "creatorRoyaltySellBps" INTEGER NOT NULL DEFAULT 0;

-- Lockup expiry on holdings for lockup_expiring notifications
ALTER TABLE "KeyOwnership"
ADD COLUMN "lockupExpiresAt" TIMESTAMP(3);

CREATE INDEX "KeyOwnership_lockupExpiresAt_idx" ON "KeyOwnership"("lockupExpiresAt");

-- Full-text search over creator name (displayName) and description (bio)
ALTER TABLE "CreatorProfile"
ADD COLUMN "search_vector" tsvector
GENERATED ALWAYS AS (
  setweight(to_tsvector('english', coalesce("displayName", '')), 'A') ||
  setweight(to_tsvector('english', coalesce("bio", '')), 'B')
) STORED;

CREATE INDEX "CreatorProfile_search_vector_idx"
ON "CreatorProfile"
USING GIN ("search_vector");
