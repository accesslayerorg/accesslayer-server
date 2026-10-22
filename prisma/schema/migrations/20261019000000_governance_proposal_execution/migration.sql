-- Governance proposal execution tracking.
--
-- Adds the timestamp stamped when a ProposalExecuted contract event is
-- indexed. The proposal's `status` transitions to 'executed' at the same time.

ALTER TABLE "GovernanceProposal" ADD COLUMN "executedAt" TIMESTAMP(3);
