ALTER TABLE "vote_delegations"
  ADD COLUMN "transactionIndex" INTEGER,
  ADD COLUMN "eventIndex" INTEGER NOT NULL DEFAULT -1;
ALTER TABLE "vote_delegation_history"
  ADD COLUMN "transactionIndex" INTEGER;

-- Recover known event indices for legacy current rows from their receipts.
-- A missing legacy transaction ordinal remains NULL rather than a guessed zero.
UPDATE "vote_delegations" AS d
SET "eventIndex" = COALESCE((
  SELECT MAX(h."eventIndex") FROM "vote_delegation_history" AS h
  WHERE h."delegatorWallet" = d."delegatorWallet" AND h."keyId" = d."keyId"
    AND h."txHash" = d."txHash" AND h."ledger" = d."ledger"
), -1);
