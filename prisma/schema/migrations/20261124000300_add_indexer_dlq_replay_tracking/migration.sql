SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- AlterTable
ALTER TABLE "IndexerDLQ" ADD COLUMN "replayCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "lastReplayAt" TIMESTAMP(3),
ADD COLUMN "lastReplayOutcome" TEXT,
ADD COLUMN "replayedAt" TIMESTAMP(3);
