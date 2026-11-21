-- Migration: add_staking_nfts (#932)
--
-- Creates the staking NFT read model:
--   staking_nfts          — one row per minted stake receipt NFT
--   staking_nft_transfers — append-only ownership history per NFT
--
-- Also extends the ActivityType enum with the two new staking event types so
-- the indexer can write audit-trail Activity records.

-- staking_nfts ──────────────────────────────────────────────────────────────

CREATE TABLE "staking_nfts" (
    "id"               TEXT         NOT NULL,
    "tokenId"          TEXT         NOT NULL,
    "ownerAddress"     TEXT         NOT NULL,
    "keyId"            TEXT         NOT NULL,
    "stakedAmount"     DECIMAL(30, 7) NOT NULL,
    "lockExpiryLedger" INTEGER,
    "lockExpiresAt"    TIMESTAMP(3),
    "burned"           BOOLEAN      NOT NULL DEFAULT FALSE,
    "burnedAt"         TIMESTAMP(3),
    "mintLedger"       INTEGER      NOT NULL,
    "mintTxHash"       TEXT         NOT NULL,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staking_nfts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "staking_nfts_tokenId_key"    ON "staking_nfts" ("tokenId");
CREATE UNIQUE INDEX "staking_nfts_mintTxHash_key" ON "staking_nfts" ("mintTxHash");
CREATE        INDEX "staking_nfts_ownerAddress_idx"        ON "staking_nfts" ("ownerAddress");
CREATE        INDEX "staking_nfts_keyId_idx"               ON "staking_nfts" ("keyId");
CREATE        INDEX "staking_nfts_ownerAddress_burned_idx" ON "staking_nfts" ("ownerAddress", "burned");

-- staking_nft_transfers ─────────────────────────────────────────────────────

CREATE TABLE "staking_nft_transfers" (
    "id"          TEXT         NOT NULL,
    "nftId"       TEXT         NOT NULL,
    "fromAddress" TEXT,
    "toAddress"   TEXT         NOT NULL,
    "ledger"      INTEGER      NOT NULL,
    "txHash"      TEXT         NOT NULL,
    "eventIndex"  INTEGER      NOT NULL,
    "occurredAt"  TIMESTAMP(3) NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staking_nft_transfers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "staking_nft_transfers_txHash_eventIndex_key"
    ON "staking_nft_transfers" ("txHash", "eventIndex");

CREATE INDEX "staking_nft_transfers_nftId_occurredAt_idx"
    ON "staking_nft_transfers" ("nftId", "occurredAt" DESC);

CREATE INDEX "staking_nft_transfers_toAddress_idx"
    ON "staking_nft_transfers" ("toAddress");

ALTER TABLE "staking_nft_transfers"
    ADD CONSTRAINT "staking_nft_transfers_nftId_fkey"
    FOREIGN KEY ("nftId") REFERENCES "staking_nfts" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ActivityType enum extensions ──────────────────────────────────────────────

ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'STAKE_NFT_MINTED';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'STAKE_NFT_TRANSFERRED';
