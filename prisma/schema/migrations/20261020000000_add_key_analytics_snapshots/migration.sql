CREATE TABLE "key_snapshots" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "snapshotDate" DATE NOT NULL,
    "metrics" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "key_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "key_snapshots_keyId_snapshotDate_key"
    ON "key_snapshots"("keyId", "snapshotDate");
CREATE INDEX "key_snapshots_snapshotDate_idx"
    ON "key_snapshots"("snapshotDate");

CREATE TABLE "snapshot_errors" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "snapshotDate" DATE NOT NULL,
    "error" TEXT NOT NULL,
    "firstFailedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retryAt" TIMESTAMP(3) NOT NULL,
    "retryExpiresAt" TIMESTAMP(3) NOT NULL,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "resolvedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "snapshot_errors_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "snapshot_errors_keyId_snapshotDate_key"
    ON "snapshot_errors"("keyId", "snapshotDate");
CREATE INDEX "snapshot_errors_resolvedAt_retryAt_retryExpiresAt_idx"
    ON "snapshot_errors"("resolvedAt", "retryAt", "retryExpiresAt");
