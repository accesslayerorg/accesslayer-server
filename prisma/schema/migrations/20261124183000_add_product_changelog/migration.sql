-- Product changelog entries and per-wallet unread tracking (#1356).
SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- CreateEnum
CREATE TYPE "ChangelogCategory" AS ENUM ('NEW', 'IMPROVED', 'FIXED');

-- CreateEnum
CREATE TYPE "ChangelogStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PUBLISHED');

-- CreateTable
CREATE TABLE "changelog_entries" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" "ChangelogCategory" NOT NULL,
    "status" "ChangelogStatus" NOT NULL DEFAULT 'DRAFT',
    "version" TEXT,
    "url" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "changelog_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "changelog_reads" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "changelog_reads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "changelog_entries_status_publishedAt_id_idx" ON "changelog_entries"("status", "publishedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "changelog_entries_category_status_publishedAt_idx" ON "changelog_entries"("category", "status", "publishedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "changelog_reads_walletAddress_key" ON "changelog_reads"("walletAddress");
