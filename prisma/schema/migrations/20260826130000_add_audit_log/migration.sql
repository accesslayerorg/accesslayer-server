-- Create audit_log table for admin action tracking
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "actorWallet" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "targetId" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- Index for efficient querying by actionType and createdAt
CREATE INDEX "audit_log_actionType_createdAt_idx" ON "audit_log"("actionType", "createdAt" DESC);

-- Index for querying by createdAt for pagination
CREATE INDEX "audit_log_createdAt_idx" ON "audit_log"("createdAt" DESC);

-- Index for querying by actor
CREATE INDEX "audit_log_actorWallet_idx" ON "audit_log"("actorWallet");
