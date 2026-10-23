CREATE TABLE "key_polls" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "key_polls_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "key_polls_keyId_pollId_key"
ON "key_polls"("keyId", "pollId");
CREATE INDEX "key_polls_keyId_status_idx"
ON "key_polls"("keyId", "status");
CREATE INDEX "key_polls_keyId_expiresAt_idx"
ON "key_polls"("keyId", "expiresAt");

CREATE TABLE "poll_votes" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "optionIndex" INTEGER NOT NULL,
    "weight" DECIMAL(30,7) NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "castAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "poll_votes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "poll_votes_keyId_pollId_wallet_key"
ON "poll_votes"("keyId", "pollId", "wallet");
CREATE UNIQUE INDEX "poll_votes_txHash_eventIndex_key"
ON "poll_votes"("txHash", "eventIndex");
CREATE INDEX "poll_votes_keyId_pollId_optionIndex_idx"
ON "poll_votes"("keyId", "pollId", "optionIndex");
