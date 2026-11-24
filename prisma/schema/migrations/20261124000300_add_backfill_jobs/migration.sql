-- CreateTable
CREATE TABLE "backfill_jobs" (
    "id" TEXT NOT NULL,
    "runKey" TEXT NOT NULL,
    "shardIndex" INTEGER NOT NULL,
    "contractId" TEXT NOT NULL,
    "fromLedger" INTEGER NOT NULL,
    "toLedger" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "eventsFetched" INTEGER NOT NULL DEFAULT 0,
    "eventsInserted" INTEGER NOT NULL DEFAULT 0,
    "eventsDuplicate" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "backfill_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "backfill_jobs_runKey_shardIndex_key" ON "backfill_jobs"("runKey", "shardIndex");

-- CreateIndex
CREATE INDEX "backfill_jobs_status_idx" ON "backfill_jobs"("status");
