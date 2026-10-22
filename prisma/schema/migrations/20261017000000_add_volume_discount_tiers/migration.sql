-- Fee discount tiers indexed from contract events (#1030)
CREATE TABLE "volume_discount_tiers" (
    "id" TEXT NOT NULL,
    "tier" INTEGER NOT NULL,
    "name" TEXT,
    "volumeThreshold" DECIMAL(30,0) NOT NULL,
    "discountBps" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "volume_discount_tiers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "volume_discount_tiers_tier_key" ON "volume_discount_tiers"("tier");
