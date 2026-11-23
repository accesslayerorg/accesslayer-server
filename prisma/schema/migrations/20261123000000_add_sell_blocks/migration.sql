CREATE TABLE "sell_blocks" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sell_blocks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sell_blocks_txHash_eventIndex_key"
    ON "sell_blocks"("txHash", "eventIndex");

CREATE INDEX "sell_blocks_wallet_ledger_idx"
    ON "sell_blocks"("wallet", "ledger");

CREATE INDEX "sell_blocks_createdAt_idx"
    ON "sell_blocks"("createdAt");
