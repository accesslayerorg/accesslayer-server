CREATE TABLE "launch_cap_configs" (
    "keyId" TEXT NOT NULL,
    "startLedger" INTEGER NOT NULL,
    "endLedger" INTEGER NOT NULL,
    "startCap" TEXT NOT NULL,
    "endCap" TEXT NOT NULL,
    "exemptWallets" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "launch_cap_configs_pkey" PRIMARY KEY ("keyId")
);

CREATE TABLE "launch_purchases" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "amount" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "launch_purchases_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "launch_purchases_keyId_wallet_idx" ON "launch_purchases"("keyId", "wallet");
CREATE INDEX "launch_purchases_keyId_ledger_idx" ON "launch_purchases"("keyId", "ledger");
