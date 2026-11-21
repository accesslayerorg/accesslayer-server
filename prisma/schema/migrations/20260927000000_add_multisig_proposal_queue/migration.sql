-- Multisig proposal queue for admin operations requiring multi-sig approval.
-- Supports configurable threshold (default 2-of-3) with signature tracking.

CREATE TABLE "multisig_proposals" (
    "id"                TEXT NOT NULL,
    "proposalId"        TEXT NOT NULL,
    "changeType"        TEXT NOT NULL,
    "payload"           JSONB NOT NULL,
    "status"            TEXT NOT NULL DEFAULT 'pending',
    "threshold"         INTEGER NOT NULL DEFAULT 2,
    "totalSigners"      INTEGER NOT NULL DEFAULT 3,
    "proposedBy"        TEXT NOT NULL,
    "proposedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executedAt"        TIMESTAMP(3),
    "rejectedAt"        TIMESTAMP(3),
    "rejectedBy"        TEXT,
    "rejectionReason"   TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "multisig_proposals_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "multisig_proposals_proposalId_key" ON "multisig_proposals"("proposalId");
CREATE INDEX "multisig_proposals_status_idx" ON "multisig_proposals"("status");
CREATE INDEX "multisig_proposals_proposedBy_idx" ON "multisig_proposals"("proposedBy");

CREATE TABLE "multisig_signatures" (
    "id"          TEXT NOT NULL,
    "proposalId"  TEXT NOT NULL,
    "signer"      TEXT NOT NULL,
    "signedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "multisig_signatures_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "multisig_signatures_proposalId_signer_key" ON "multisig_signatures"("proposalId", "signer");
CREATE INDEX "multisig_signatures_signer_idx" ON "multisig_signatures"("signer");
CREATE INDEX "multisig_signatures_proposalId_idx" ON "multisig_signatures"("proposalId");

ALTER TABLE "multisig_signatures"
    ADD CONSTRAINT "multisig_signatures_proposalId_fkey"
    FOREIGN KEY ("proposalId")
    REFERENCES "multisig_proposals"("proposalId")
    ON DELETE CASCADE
    ON UPDATE CASCADE;