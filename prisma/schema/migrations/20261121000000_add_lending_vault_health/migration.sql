-- Open lending-vault positions and the monitor's latest health snapshot per
-- position. Health = collateral value x liquidation threshold / debt.

CREATE TABLE "lending_positions" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "collateralKeyId" TEXT NOT NULL,
    "collateralQuantity" DECIMAL(20,7) NOT NULL,
    "principalXlm" DECIMAL(20,7) NOT NULL,
    "interestRateBps" INTEGER NOT NULL DEFAULT 0,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "liquidatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lending_positions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "lending_positions_wallet_idx" ON "lending_positions"("wallet");
CREATE INDEX "lending_positions_liquidatedAt_idx" ON "lending_positions"("liquidatedAt");

CREATE TABLE "vault_health" (
    "id" TEXT NOT NULL,
    "positionId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "healthFactor" DECIMAL(18,8) NOT NULL,
    "collateralValueXlm" DECIMAL(20,7) NOT NULL,
    "debtXlm" DECIMAL(20,7) NOT NULL,
    "liquidationPriceXlm" DECIMAL(20,7),
    "warningAt" TIMESTAMP(3),
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vault_health_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vault_health_positionId_key" ON "vault_health"("positionId");
CREATE INDEX "vault_health_wallet_idx" ON "vault_health"("wallet");
CREATE INDEX "vault_health_healthFactor_idx" ON "vault_health"("healthFactor");

ALTER TABLE "vault_health" ADD CONSTRAINT "vault_health_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "lending_positions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
