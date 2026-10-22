-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "criteriaType" TEXT NOT NULL DEFAULT 'TRADE_VOLUME',
    "threshold" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "criteria" JSONB,
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3) NOT NULL,
    "contractAddress" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_qualification_log" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUALIFIED',
    "metricValue" DECIMAL(65,30),
    "txHash" TEXT,
    "error" TEXT,
    "qualifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_qualification_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaigns_status_idx" ON "campaigns"("status");
CREATE INDEX "campaigns_startDate_endDate_idx" ON "campaigns"("startDate", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_qualification_log_campaignId_wallet_key" ON "campaign_qualification_log"("campaignId", "wallet");
CREATE INDEX "campaign_qualification_log_campaignId_idx" ON "campaign_qualification_log"("campaignId");
CREATE INDEX "campaign_qualification_log_wallet_idx" ON "campaign_qualification_log"("wallet");
CREATE INDEX "campaign_qualification_log_status_idx" ON "campaign_qualification_log"("status");

-- AddForeignKey
ALTER TABLE "campaign_qualification_log" ADD CONSTRAINT "campaign_qualification_log_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
