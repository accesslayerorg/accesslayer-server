ALTER TABLE "CreatorProfile"
ADD COLUMN "whitelist_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "whitelist_root" TEXT;
