ALTER TABLE "campaigns" ALTER COLUMN "threshold" TYPE DECIMAL(78,30);
ALTER TABLE "campaigns"
  ADD COLUMN "rewardPool" DECIMAL(39,0) NOT NULL DEFAULT 0,
  ADD COLUMN "ledger" INTEGER,
  ADD COLUMN "eventIndex" INTEGER,
  ADD COLUMN "txHash" TEXT;

CREATE TABLE "campaign_eligibility" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "wallet" TEXT NOT NULL,
  "eligible" BOOLEAN NOT NULL DEFAULT false,
  "score" DECIMAL(39,0) NOT NULL DEFAULT 0,
  "criteriaProgress" JSONB,
  "claimedAmount" DECIMAL(39,0) NOT NULL DEFAULT 0,
  "claimed" BOOLEAN NOT NULL DEFAULT false,
  "ledger" INTEGER,
  "eventIndex" INTEGER,
  "txHash" TEXT,
  "qualifiedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "campaign_eligibility_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "campaign_eligibility_campaignId_wallet_key"
  ON "campaign_eligibility"("campaignId", "wallet");
CREATE INDEX "campaign_eligibility_campaignId_eligible_score_wallet_idx"
  ON "campaign_eligibility"("campaignId", "eligible", "score" DESC, "wallet");
CREATE INDEX "campaign_eligibility_wallet_idx" ON "campaign_eligibility"("wallet");

CREATE TABLE "campaign_events" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "wallet" TEXT,
  "ledger" INTEGER NOT NULL,
  "txHash" TEXT NOT NULL,
  "eventIndex" INTEGER NOT NULL,
  "totalScore" DECIMAL(39,0),
  "payload" JSONB NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "campaign_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "campaign_events_txHash_eventIndex_key"
  ON "campaign_events"("txHash", "eventIndex");
CREATE INDEX "campaign_events_campaignId_ledger_eventIndex_idx"
  ON "campaign_events"("campaignId", "ledger", "eventIndex");

CREATE INDEX "campaign_events_campaignId_type_totalScore_idx"
  ON "campaign_events"("campaignId", "type", "totalScore" DESC);
