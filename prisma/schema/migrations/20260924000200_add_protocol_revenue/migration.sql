-- Protocol revenue distribution cycles + claim-based dividends (#883)
CREATE TABLE "RevenueCycle" (
    "id" TEXT NOT NULL,
    "cycleIndex" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "totalFeesXlm" DECIMAL(20,7) NOT NULL DEFAULT 0,
    "distributedXlm" DECIMAL(20,7) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RevenueCycle_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RevenueCycle_cycleIndex_key" ON "RevenueCycle"("cycleIndex");
CREATE INDEX "RevenueCycle_startsAt_idx" ON "RevenueCycle"("startsAt");

CREATE TABLE "RevenueClaim" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "entitledAmountXlm" DECIMAL(20,7) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RevenueClaim_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RevenueClaim_cycleId_fkey" FOREIGN KEY ("cycleId")
      REFERENCES "RevenueCycle"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RevenueClaim_cycleId_wallet_key" ON "RevenueClaim"("cycleId", "wallet");
CREATE INDEX "RevenueClaim_wallet_idx" ON "RevenueClaim"("wallet");
