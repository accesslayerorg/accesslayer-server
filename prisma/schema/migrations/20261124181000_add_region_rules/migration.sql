-- Jurisdiction restriction rules (#1354).
SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- CreateEnum
CREATE TYPE "RegionRuleAction" AS ENUM ('BLOCK');

-- CreateTable
CREATE TABLE "region_rules" (
    "id" TEXT NOT NULL,
    "feature" TEXT NOT NULL,
    "countryCode" VARCHAR(2) NOT NULL,
    "action" "RegionRuleAction" NOT NULL DEFAULT 'BLOCK',
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "region_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "region_rules_countryCode_idx" ON "region_rules"("countryCode");

-- CreateIndex
CREATE UNIQUE INDEX "region_rules_feature_countryCode_key" ON "region_rules"("feature", "countryCode");
