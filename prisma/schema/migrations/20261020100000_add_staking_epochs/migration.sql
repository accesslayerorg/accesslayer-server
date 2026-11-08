-- Staking epoch indexer: stakes and epoch_rewards tables (#1086)

CREATE TABLE "stakes" (
    "id"          TEXT          NOT NULL,
    "wallet"      TEXT          NOT NULL,
    "keyId"       TEXT          NOT NULL,
    "amount"      DECIMAL(20,7) NOT NULL,
    "startEpoch"  INTEGER       NOT NULL,
    "epochsTotal" INTEGER,
    "removedAt"   TIMESTAMP(3),
    "ledger"      INTEGER       NOT NULL,
    "txHash"      TEXT          NOT NULL,
    "eventIndex"  INTEGER       NOT NULL,
    "createdAt"   TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3)  NOT NULL,

    CONSTRAINT "stakes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "stakes_txHash_eventIndex_key"
    ON "stakes"("txHash", "eventIndex");

CREATE INDEX "stakes_wallet_removedAt_idx"
    ON "stakes"("wallet", "removedAt");

CREATE INDEX "stakes_keyId_idx"
    ON "stakes"("keyId");

-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE "epoch_rewards" (
    "id"               TEXT          NOT NULL,
    "epoch"            INTEGER       NOT NULL,
    "keyId"            TEXT          NOT NULL,
    "totalDistributed" DECIMAL(20,7) NOT NULL,
    "ledger"           INTEGER       NOT NULL,
    "txHash"           TEXT          NOT NULL,
    "eventIndex"       INTEGER       NOT NULL,
    "distributedAt"    TIMESTAMP(3)  NOT NULL,
    "createdAt"        TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "epoch_rewards_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "epoch_rewards_txHash_eventIndex_key"
    ON "epoch_rewards"("txHash", "eventIndex");

CREATE INDEX "epoch_rewards_keyId_epoch_idx"
    ON "epoch_rewards"("keyId", "epoch");

CREATE INDEX "epoch_rewards_epoch_idx"
    ON "epoch_rewards"("epoch");
