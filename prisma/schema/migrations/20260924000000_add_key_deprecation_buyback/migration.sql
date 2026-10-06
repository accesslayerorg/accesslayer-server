-- Key deprecation + guaranteed holder buyback (#882)
ALTER TABLE "CreatorProfile"
ADD COLUMN "deprecatedAt" TIMESTAMP(3),
ADD COLUMN "buybackPriceXlm" DECIMAL(20,7),
ADD COLUMN "buybackExpiresAt" TIMESTAMP(3);

CREATE TABLE "KeyBuyback" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "holderAddress" TEXT NOT NULL,
    "quantity" DECIMAL(65,30) NOT NULL,
    "pricePerKeyXlm" DECIMAL(20,7) NOT NULL,
    "amountXlm" DECIMAL(20,7) NOT NULL,
    "txHash" TEXT,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KeyBuyback_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "KeyBuyback_keyId_idx" ON "KeyBuyback"("keyId");
CREATE INDEX "KeyBuyback_holderAddress_idx" ON "KeyBuyback"("holderAddress");
CREATE INDEX "KeyBuyback_processedAt_idx" ON "KeyBuyback"("processedAt" DESC);
