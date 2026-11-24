CREATE TABLE "guardian_sets" (
    "walletAddress" TEXT NOT NULL,
    "guardians" TEXT[] NOT NULL,
    "threshold" INTEGER NOT NULL,
    "delayLedgers" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "guardian_sets_pkey" PRIMARY KEY ("walletAddress")
);

CREATE TABLE "recovery_requests" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "initiator" TEXT NOT NULL,
    "newOwner" TEXT NOT NULL,
    "initiatedLedger" INTEGER NOT NULL,
    "earliestExecute" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "executedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "recovery_requests_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "recovery_requests_walletAddress_idx" ON "recovery_requests"("walletAddress");

CREATE TABLE "recovery_approvals" (
    "requestId" TEXT NOT NULL,
    "guardian" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "recovery_approvals_pkey" PRIMARY KEY ("requestId", "guardian")
);

ALTER TABLE "recovery_approvals" ADD CONSTRAINT "recovery_approvals_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "recovery_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "recovery_notifications" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'high',
    "channel" TEXT NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "recovery_notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "recovery_notifications_walletAddress_idx" ON "recovery_notifications"("walletAddress");
CREATE INDEX "recovery_notifications_requestId_idx" ON "recovery_notifications"("requestId");
