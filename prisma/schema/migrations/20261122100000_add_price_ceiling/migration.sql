-- Price ceiling and buy cool-off read model (#1266).
CREATE TABLE "price_ceilings" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "ceiling" DECIMAL(36,7) NOT NULL,
    "cooloffLedgers" INTEGER NOT NULL DEFAULT 0,
    "cooloffEndsAt" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "price_ceilings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "price_ceilings_keyId_key" ON "price_ceilings"("keyId");
CREATE INDEX "price_ceilings_keyId_idx" ON "price_ceilings"("keyId");
