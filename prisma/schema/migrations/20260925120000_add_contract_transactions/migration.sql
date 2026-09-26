-- Centralised Soroban contract interaction service (#899)
CREATE TABLE "ContractTransaction" (
    "id" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "submitterWallet" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "lastError" TEXT,
    "errorKind" TEXT,
    "ledger" INTEGER,
    "resultXdr" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractTransaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContractTransaction_txHash_key" ON "ContractTransaction"("txHash");
CREATE INDEX "ContractTransaction_status_idx" ON "ContractTransaction"("status");
CREATE INDEX "ContractTransaction_submitterWallet_idx" ON "ContractTransaction"("submitterWallet");
CREATE INDEX "ContractTransaction_createdAt_idx" ON "ContractTransaction"("createdAt");
