CREATE TABLE "payment_assets" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL DEFAULT 7,
    "oracle" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "rate7" BIGINT,
    "rateUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "payment_assets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "payment_assets_token_key" ON "payment_assets"("token");
CREATE INDEX "payment_assets_enabled_idx" ON "payment_assets"("enabled");
CREATE INDEX "payment_assets_symbol_idx" ON "payment_assets"("symbol");
