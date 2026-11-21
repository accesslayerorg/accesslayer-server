-- Price velocity circuit breaker trips (#1195).
CREATE TABLE "price_velocity_breaker_trips" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "velocityPct" DECIMAL(20,6) NOT NULL,
    "thresholdPct" DECIMAL(20,6) NOT NULL,
    "windowSize" INTEGER NOT NULL,
    "currentPrice" TEXT NOT NULL,
    "referencePrice" TEXT NOT NULL,
    "tradeTxHash" TEXT NOT NULL,
    "tradeLedger" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'tripped',
    "triggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resetByWallet" TEXT,
    "resetAt" TIMESTAMP(3),

    CONSTRAINT "price_velocity_breaker_trips_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "price_velocity_breaker_trips_keyId_status_idx" ON "price_velocity_breaker_trips"("keyId", "status");
CREATE INDEX "price_velocity_breaker_trips_triggeredAt_idx" ON "price_velocity_breaker_trips"("triggeredAt");
