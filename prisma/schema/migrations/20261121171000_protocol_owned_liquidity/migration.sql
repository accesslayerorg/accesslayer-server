CREATE TABLE "pol_reserves" (
  "id" TEXT NOT NULL,
  "balance" DECIMAL(39,0) NOT NULL DEFAULT 0,
  "deployedAmount" DECIMAL(39,0) NOT NULL DEFAULT 0,
  "repaidAmount" DECIMAL(39,0) NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pol_reserves_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "pol_backstops" (
  "id" TEXT NOT NULL,
  "keyId" TEXT,
  "type" TEXT NOT NULL,
  "amount" DECIMAL(39,0) NOT NULL,
  "ledger" INTEGER NOT NULL,
  "eventIndex" INTEGER NOT NULL,
  "txHash" TEXT NOT NULL,
  "timestamp" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pol_backstops_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "pol_backstops_txHash_eventIndex_key" ON "pol_backstops"("txHash", "eventIndex");
CREATE INDEX "pol_backstops_keyId_ledger_eventIndex_idx" ON "pol_backstops"("keyId", "ledger", "eventIndex");
