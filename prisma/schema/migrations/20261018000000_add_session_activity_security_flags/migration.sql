-- Session activity logging + security anomaly flags (#1035)
CREATE TABLE "session_activity" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "userAgent" TEXT,
    "method" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "session_activity_wallet_timestamp_idx" ON "session_activity"("wallet", "timestamp" DESC);

-- CreateIndex
CREATE INDEX "session_activity_wallet_ip_idx" ON "session_activity"("wallet", "ip");

-- CreateIndex
CREATE INDEX "session_activity_timestamp_idx" ON "session_activity"("timestamp" DESC);

CREATE TABLE "security_flags" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "endpoint" TEXT,
    "reason" TEXT NOT NULL,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_flags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "security_flags_wallet_reason_idx" ON "security_flags"("wallet", "reason");

-- CreateIndex
CREATE INDEX "security_flags_createdAt_idx" ON "security_flags"("createdAt" DESC);
