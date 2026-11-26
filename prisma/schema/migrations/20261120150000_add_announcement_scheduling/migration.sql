SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- CreateEnum
CREATE TYPE "AnnouncementStatus" AS ENUM ('draft', 'scheduled', 'published', 'cancelled');

-- CreateTable
CREATE TABLE "announcements" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "status" "AnnouncementStatus" NOT NULL DEFAULT 'draft',
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "announcements_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "CreatorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "announcements_keyId_status_idx" ON "announcements"("keyId", "status");

-- CreateIndex
CREATE INDEX "announcements_status_scheduledAt_idx" ON "announcements"("status", "scheduledAt");
