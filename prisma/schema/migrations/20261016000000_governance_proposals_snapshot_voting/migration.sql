-- #878: governance snapshot voting weight and quorum tracking.

-- AlterEnum: dedicated activity type for snapshot governance votes.
ALTER TYPE "ActivityType" ADD VALUE 'GOVERNANCE_VOTE_CAST';

-- AlterTable: eligible weight frozen at the snapshot block + quorum threshold.
ALTER TABLE "GovernanceProposal"
ADD COLUMN     "snapshotTotalWeight" TEXT NOT NULL DEFAULT '0',
ADD COLUMN     "quorumBps" INTEGER NOT NULL DEFAULT 3000;

-- CreateTable: per-wallet staked balance captured at proposal creation.
CREATE TABLE "governance_voting_snapshots" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "weight" DECIMAL(30,7) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "governance_voting_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "governance_voting_snapshots_keyId_proposalId_wallet_key" ON "governance_voting_snapshots"("keyId", "proposalId", "wallet");

-- CreateIndex
CREATE INDEX "governance_voting_snapshots_keyId_proposalId_idx" ON "governance_voting_snapshots"("keyId", "proposalId");
