-- Public portfolio profiles with handle registry and privacy controls (#1355).
SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- CreateTable
CREATE TABLE "public_profiles" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "showHoldings" BOOLEAN NOT NULL DEFAULT false,
    "showPnl" BOOLEAN NOT NULL DEFAULT false,
    "showKeyCount" BOOLEAN NOT NULL DEFAULT false,
    "showJoined" BOOLEAN NOT NULL DEFAULT false,
    "showWallet" BOOLEAN NOT NULL DEFAULT false,
    "showExactAmounts" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "public_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "public_profiles_wallet_key" ON "public_profiles"("wallet");

-- CreateIndex
CREATE UNIQUE INDEX "public_profiles_handle_key" ON "public_profiles"("handle");
