DROP INDEX IF EXISTS "CreatorProfile_userId_key";
CREATE INDEX "CreatorProfile_userId_idx" ON "CreatorProfile"("userId");