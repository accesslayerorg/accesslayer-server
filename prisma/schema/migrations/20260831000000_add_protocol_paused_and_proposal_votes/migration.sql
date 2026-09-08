-- AlterTable
ALTER TABLE "protocol_config" ADD COLUMN "pausedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "proposal_votes" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "voter" TEXT NOT NULL,
    "optionIndex" INTEGER NOT NULL,
    "weight" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "proposal_votes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "proposal_votes_keyId_proposalId_voter_key" ON "proposal_votes"("keyId", "proposalId", "voter");

-- CreateIndex
CREATE INDEX "proposal_votes_keyId_proposalId_idx" ON "proposal_votes"("keyId", "proposalId");
