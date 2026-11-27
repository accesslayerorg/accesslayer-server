SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- CreateTable
CREATE TABLE "token_rescues" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "admin" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "token_rescues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "token_rescues_txHash_eventIndex_key" ON "token_rescues"("txHash", "eventIndex");

-- CreateIndex
CREATE INDEX "token_rescues_token_ledger_idx" ON "token_rescues"("token", "ledger" DESC);
