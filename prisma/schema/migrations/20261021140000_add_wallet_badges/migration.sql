CREATE TABLE "wallet_badges" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "badgeType" TEXT NOT NULL,
    "mintedAt" TIMESTAMP(3) NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "ledger" INTEGER NOT NULL,

    CONSTRAINT "wallet_badges_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wallet_badges_wallet_badgeType_key"
    ON "wallet_badges"("wallet", "badgeType");
CREATE UNIQUE INDEX "wallet_badges_txHash_eventIndex_key"
    ON "wallet_badges"("txHash", "eventIndex");
CREATE INDEX "wallet_badges_wallet_mintedAt_idx"
    ON "wallet_badges"("wallet", "mintedAt");
