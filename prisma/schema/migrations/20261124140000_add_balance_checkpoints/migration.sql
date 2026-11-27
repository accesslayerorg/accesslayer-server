-- CreateTable
CREATE TABLE "balance_checkpoints" (
    "id" TEXT NOT NULL,
    "holder" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "balance" DECIMAL(20,7) NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "balance_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "balance_checkpoints_holder_keyId_ledger_key" ON "balance_checkpoints"("holder", "keyId", "ledger");

-- CreateIndex
CREATE INDEX "balance_checkpoints_holder_keyId_ledger_idx" ON "balance_checkpoints"("holder", "keyId", "ledger");

-- CreateIndex
CREATE INDEX "balance_checkpoints_timestamp_idx" ON "balance_checkpoints"("timestamp");
