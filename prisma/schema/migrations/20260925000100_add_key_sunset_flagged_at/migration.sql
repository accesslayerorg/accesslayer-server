-- Migration: add_key_sunset_flagged_at (#931)
--
-- Adds sunsetFlaggedAt to CreatorProfile so the indexer can persist the
-- timestamp when a KeySunsetFlagged on-chain event is processed.  The column
-- is nullable; NULL means the key has never been flagged for sunset.
--
-- Also extends the ActivityType enum with KEY_SUNSET_FLAGGED so the event
-- can be written to the Activity audit trail.

ALTER TABLE "CreatorProfile" ADD COLUMN "sunsetFlaggedAt" TIMESTAMP(3);

ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'KEY_SUNSET_FLAGGED';
