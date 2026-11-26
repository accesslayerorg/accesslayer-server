CREATE TABLE "bounties" (
    "id" TEXT NOT NULL,
    "onChainId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "creatorHandle" TEXT NOT NULL,
    "creatorWallet" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "rewardAmount" BIGINT NOT NULL,
    "awardedAmount" BIGINT NOT NULL DEFAULT 0,
    "reclaimedAmount" BIGINT NOT NULL DEFAULT 0,
    "maxWinners" INTEGER NOT NULL DEFAULT 1,
    "winnersCount" INTEGER NOT NULL DEFAULT 0,
    "deadlineLedger" INTEGER NOT NULL,
    "reclaimedAtLedger" INTEGER,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "bounties_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bounties_onChainId_key" ON "bounties"("onChainId");
CREATE INDEX "bounties_keyId_idx" ON "bounties"("keyId");
CREATE INDEX "bounties_creatorHandle_idx" ON "bounties"("creatorHandle");
CREATE INDEX "bounties_rewardAmount_idx" ON "bounties"("rewardAmount");

CREATE TABLE "bounty_submissions" (
    "id" TEXT NOT NULL,
    "bountyId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "submitter" TEXT NOT NULL,
    "contentUri" TEXT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bounty_submissions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bounty_submissions_txHash_eventIndex_key" ON "bounty_submissions"("txHash", "eventIndex");
CREATE UNIQUE INDEX "bounty_submissions_bountyId_submissionId_key" ON "bounty_submissions"("bountyId", "submissionId");
CREATE INDEX "bounty_submissions_bountyId_idx" ON "bounty_submissions"("bountyId");

CREATE TABLE "bounty_awards" (
    "id" TEXT NOT NULL,
    "bountyId" TEXT NOT NULL,
    "submissionId" TEXT,
    "winner" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "ledger" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "bounty_awards_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "bounty_awards_txHash_eventIndex_key" ON "bounty_awards"("txHash", "eventIndex");
CREATE INDEX "bounty_awards_bountyId_idx" ON "bounty_awards"("bountyId");

ALTER TABLE "bounty_submissions" ADD CONSTRAINT "bounty_submissions_bountyId_fkey"
    FOREIGN KEY ("bountyId") REFERENCES "bounties"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "bounty_awards" ADD CONSTRAINT "bounty_awards_bountyId_fkey"
    FOREIGN KEY ("bountyId") REFERENCES "bounties"("id") ON DELETE CASCADE ON UPDATE CASCADE;
