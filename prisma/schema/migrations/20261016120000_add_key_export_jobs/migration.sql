-- #1014: Async key analytics export jobs
-- Backs GET /keys/:keyId/export?format=csv|json&from=&to=. The route inserts
-- a PENDING row and returns a signed download URL immediately; a worker
-- fills content/status, and the signed download endpoint serves it.

-- CreateTable
CREATE TABLE "key_export_jobs" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "from" TIMESTAMP(3),
    "to" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "fileName" TEXT,
    "contentType" TEXT,
    "content" TEXT,
    "recordCount" INTEGER,
    "error" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "key_export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "key_export_jobs_keyId_createdAt_idx" ON "key_export_jobs"("keyId", "createdAt");

-- CreateIndex
CREATE INDEX "key_export_jobs_status_idx" ON "key_export_jobs"("status");
