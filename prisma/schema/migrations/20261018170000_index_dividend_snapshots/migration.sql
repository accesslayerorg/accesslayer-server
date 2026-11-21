ALTER TYPE "ActivityType" ADD VALUE IF NOT EXISTS 'DIVIDEND_CLAIMED';

ALTER TABLE "DividendDistribution" RENAME TO "dividend_snapshots";
ALTER TABLE "DividendClaim" RENAME TO "dividend_claims";

ALTER TABLE "dividend_snapshots"
    RENAME CONSTRAINT "DividendDistribution_pkey" TO "dividend_snapshots_pkey";
ALTER TABLE "dividend_claims"
    RENAME CONSTRAINT "DividendClaim_pkey" TO "dividend_claims_pkey";
ALTER TABLE "dividend_claims"
    RENAME CONSTRAINT "DividendClaim_distributionId_recipientAddress_key"
    TO "dividend_claims_distributionId_recipientAddress_key";
ALTER TABLE "dividend_claims"
    RENAME CONSTRAINT "DividendClaim_distributionId_fkey"
    TO "dividend_claims_distributionId_fkey";

ALTER INDEX "DividendDistribution_creatorId_idx"
    RENAME TO "dividend_snapshots_creatorId_idx";
ALTER INDEX "DividendDistribution_distributionDate_idx"
    RENAME TO "dividend_snapshots_distributionDate_idx";
ALTER INDEX "DividendClaim_recipientAddress_idx"
    RENAME TO "dividend_claims_recipientAddress_idx";
ALTER INDEX "DividendClaim_distributionId_idx"
    RENAME TO "dividend_claims_distributionId_idx";

ALTER TABLE "dividend_snapshots"
    ADD COLUMN "claimWindowStart" TIMESTAMP(3),
    ADD COLUMN "claimWindowEnd" TIMESTAMP(3),
    ADD COLUMN "chainSnapshotId" TEXT,
    ADD COLUMN "eventIndex" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "dividend_snapshots"
    DROP CONSTRAINT "DividendDistribution_ledger_txHash_key";

ALTER TABLE "dividend_snapshots"
    ADD CONSTRAINT "dividend_snapshots_ledger_txHash_eventIndex_key"
    UNIQUE ("ledger", "txHash", "eventIndex");

ALTER TABLE "dividend_snapshots"
    ADD CONSTRAINT "dividend_snapshots_creatorId_chainSnapshotId_key"
    UNIQUE ("creatorId", "chainSnapshotId");

ALTER TABLE "dividend_claims"
    DROP CONSTRAINT "dividend_claims_distributionId_fkey";

ALTER TABLE "dividend_claims"
    ADD CONSTRAINT "dividend_claims_distributionId_fkey"
    FOREIGN KEY ("distributionId")
    REFERENCES "dividend_snapshots"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
