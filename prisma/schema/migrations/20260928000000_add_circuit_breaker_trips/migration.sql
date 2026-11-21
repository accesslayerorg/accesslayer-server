-- Circuit breaker trip indexing (#987).
-- The indexer writes one circuit_breaker_trips row per CircuitBreakerTripped
-- contract event; the unique (txHash, eventIndex) index keeps replays
-- idempotent so a trip (and its creator notification) is never recorded twice.
CREATE TABLE "circuit_breaker_trips" (
    "id"            TEXT NOT NULL,
    "keyId"         TEXT NOT NULL,
    "creatorWallet" TEXT NOT NULL,
    "actualBps"     INTEGER NOT NULL,
    "maxBps"        INTEGER,
    "ledger"        INTEGER NOT NULL,
    "txHash"        TEXT NOT NULL,
    "eventIndex"    INTEGER NOT NULL,
    "occurredAt"    TIMESTAMP(3) NOT NULL,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "circuit_breaker_trips_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "circuit_breaker_trips_txHash_eventIndex_key" ON "circuit_breaker_trips"("txHash", "eventIndex");

-- CreateIndex
CREATE INDEX "circuit_breaker_trips_keyId_occurredAt_idx" ON "circuit_breaker_trips"("keyId", "occurredAt");

-- CreateIndex
CREATE INDEX "circuit_breaker_trips_creatorWallet_occurredAt_idx" ON "circuit_breaker_trips"("creatorWallet", "occurredAt");

-- CreateIndex
CREATE INDEX "circuit_breaker_trips_occurredAt_idx" ON "circuit_breaker_trips"("occurredAt");
