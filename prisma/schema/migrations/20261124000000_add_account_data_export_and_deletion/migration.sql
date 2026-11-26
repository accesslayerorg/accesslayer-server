-- CreateTable
CREATE TABLE "data_export_jobs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "archive" JSONB,
    "error" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "data_export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deletion_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "pseudonymId" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "error" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "data_export_jobs_userId_createdAt_idx" ON "data_export_jobs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "data_export_jobs_status_createdAt_idx" ON "data_export_jobs"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "deletion_requests_pseudonymId_key" ON "deletion_requests"("pseudonymId");

-- CreateIndex
CREATE INDEX "deletion_requests_userId_status_idx" ON "deletion_requests"("userId", "status");

-- CreateIndex
CREATE INDEX "deletion_requests_status_scheduledFor_idx" ON "deletion_requests"("status", "scheduledFor");
