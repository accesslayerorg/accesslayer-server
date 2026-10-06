-- Self-custody position freeze (#885)
ALTER TABLE "KeyOwnership"
ADD COLUMN "frozen" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "frozenAt" TIMESTAMP(3);
