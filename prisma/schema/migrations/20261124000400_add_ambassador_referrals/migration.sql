-- CreateTable
CREATE TABLE "referral_clicks" (
    "id" TEXT NOT NULL,
    "referrerWallet" TEXT NOT NULL,
    "referralCode" TEXT NOT NULL,
    "cookieId" TEXT NOT NULL,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmTerm" TEXT,
    "utmContent" TEXT,
    "clickedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_clicks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_attributions" (
    "id" TEXT NOT NULL,
    "refereeWallet" TEXT NOT NULL,
    "referrerWallet" TEXT NOT NULL,
    "clickId" TEXT,
    "cookieId" TEXT,
    "referralCode" TEXT,
    "attributedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstTradeAt" TIMESTAMP(3),
    "tradeCount" INTEGER NOT NULL DEFAULT 0,
    "totalVolume" DECIMAL(20,7) NOT NULL DEFAULT 0,
    "isHeld" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_attributions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ambassador_payouts" (
    "id" TEXT NOT NULL,
    "ambassadorWallet" TEXT NOT NULL,
    "payoutDate" DATE NOT NULL,
    "tier" INTEGER NOT NULL,
    "tierShare" DOUBLE PRECISION NOT NULL,
    "activeTraders" INTEGER NOT NULL DEFAULT 0,
    "totalFees" DECIMAL(20,7) NOT NULL,
    "accruedAmount" DECIMAL(20,7) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'accrued',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ambassador_payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "referral_clicks_cookieId_clickedAt_idx" ON "referral_clicks"("cookieId", "clickedAt" DESC);

-- CreateIndex
CREATE INDEX "referral_clicks_referrerWallet_clickedAt_idx" ON "referral_clicks"("referrerWallet", "clickedAt" DESC);

-- CreateIndex
CREATE INDEX "referral_clicks_referralCode_idx" ON "referral_clicks"("referralCode");

-- CreateIndex
CREATE UNIQUE INDEX "referral_attributions_refereeWallet_key" ON "referral_attributions"("refereeWallet");

-- CreateIndex
CREATE INDEX "referral_attributions_referrerWallet_attributedAt_idx" ON "referral_attributions"("referrerWallet", "attributedAt");

-- CreateIndex
CREATE INDEX "referral_attributions_referrerWallet_firstTradeAt_idx" ON "referral_attributions"("referrerWallet", "firstTradeAt");

-- CreateIndex
CREATE UNIQUE INDEX "ambassador_payouts_ambassadorWallet_payoutDate_key" ON "ambassador_payouts"("ambassadorWallet", "payoutDate");

-- CreateIndex
CREATE INDEX "ambassador_payouts_ambassadorWallet_payoutDate_idx" ON "ambassador_payouts"("ambassadorWallet", "payoutDate" DESC);
