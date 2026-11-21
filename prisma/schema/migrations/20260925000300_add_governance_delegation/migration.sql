-- Migration: add_governance_delegation (#933)
--
-- Creates:
--   vote_delegations        — current-state table (one row per delegator/keyId pair)
--   vote_delegation_history — append-only audit log of every delegation event
--
-- Extends ActivityType enum with the three new delegation/vote event values.

-- vote_delegations ──────────────────────────────────────────────────────────

CREATE TABLE "vote_delegations" (
    "id"              TEXT         NOT NULL,
    "delegatorWallet" TEXT         NOT NULL,
    "keyId"           TEXT         NOT NULL,
    "delegateeWallet" TEXT         NOT NULL,
    "isActive"        BOOLEAN      NOT NULL DEFAULT TRUE,
    "ledger"          INTEGER      NOT NULL,
    "txHash"          TEXT         NOT NULL,
    "occurredAt"      TIMESTAMP(3) NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vote_delegations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vote_delegations_delegatorWallet_keyId_key"
    ON "vote_delegations" ("delegatorWallet", "keyId");

CREATE INDEX "vote_delegations_delegateeWallet_isActive_idx"
    ON "vote_delegations" ("delegateeWallet", "isActive");

CREATE INDEX "vote_delegations_delegatorWallet_idx"
    ON "vote_delegations" ("delegatorWallet");

CREATE INDEX "vote_delegations_keyId_isActive_idx"
    ON "vote_delegations" ("keyId", "isActive");

-- vote_delegation_history ───────────────────────────────────────────────────

CREATE TABLE "vote_delegation_history" (
    "id"              TEXT         NOT NULL,
    "delegatorWallet" TEXT         NOT NULL,
    "keyId"           TEXT         NOT NULL,
    "delegateeWallet" TEXT,
    "action"          TEXT         NOT NULL,
    "ledger"          INTEGER      NOT NULL,
    "txHash"          TEXT         NOT NULL,
    "eventIndex"      INTEGER      NOT NULL,
    "occurredAt"      TIMESTAMP(3) NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vote_delegation_history_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "vote_delegation_history_txHash_eventIndex_key"
    ON "vote_delegation_history" ("txHash", "eventIndex");

CREATE INDEX "vote_delegation_history_delegatorWallet_occurredAt_idx"
    ON "vote_delegation_history" ("delegatorWallet", "occurredAt" DESC);

CREATE INDEX "vote_delegation_history_delegateeWallet_occurredAt_idx"
    ON "vote_delegation_history" ("delegateeWallet", "occurredAt" DESC);

CREATE INDEX "vote_delegation_history_keyId_idx"
    ON "vote_delegation_history" ("keyId");

-- ActivityType enum extensions ──────────────────────────────────────────────

ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'GOVERNANCE_VOTE_CAST';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'GOVERNANCE_DELEGATION_SET';
ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'GOVERNANCE_DELEGATION_REVOKED';
