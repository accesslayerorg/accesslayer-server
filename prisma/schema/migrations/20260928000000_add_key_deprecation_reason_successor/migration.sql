ALTER TABLE "CreatorProfile"
ADD COLUMN "reason" TEXT,
ADD COLUMN "successorKeyId" TEXT;

CREATE INDEX "CreatorProfile_successorKeyId_idx" ON "CreatorProfile"("successorKeyId");

ALTER TABLE "CreatorProfile"
ADD CONSTRAINT "CreatorProfile_successorKeyId_fkey"
FOREIGN KEY ("successorKeyId") REFERENCES "CreatorProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
