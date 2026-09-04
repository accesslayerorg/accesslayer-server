CREATE TYPE "SorobanWALOperation" AS ENUM ('buy', 'sell');
CREATE TYPE "SorobanWALState" AS ENUM ('PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED', 'ROLLED_BACK');

CREATE TABLE "soroban_wal_entries" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "operation" "SorobanWALOperation" NOT NULL,
    "wallet" TEXT NOT NULL,
    "creatorWallet" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "expectedSupplyBefore" DECIMAL(65,30) NOT NULL,
    "xdrPayload" TEXT NOT NULL,
    "state" "SorobanWALState" NOT NULL DEFAULT 'PENDING',
    "txHash" TEXT,
    "submittedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "soroban_wal_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "soroban_wal_entries_idempotencyKey_key"
    ON "soroban_wal_entries"("idempotencyKey");
CREATE UNIQUE INDEX "soroban_wal_entries_txHash_key"
    ON "soroban_wal_entries"("txHash");
CREATE INDEX "soroban_wal_entries_state_createdAt_idx"
    ON "soroban_wal_entries"("state", "createdAt");
