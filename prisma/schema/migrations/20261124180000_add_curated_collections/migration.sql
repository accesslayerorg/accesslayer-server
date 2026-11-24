-- Curated key collections, items and follows (#1353).
SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- CreateEnum
CREATE TYPE "CollectionStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateTable
CREATE TABLE "collections" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "CollectionStatus" NOT NULL DEFAULT 'DRAFT',
    "editorWallets" TEXT[],
    "followerCount" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_items" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "note" TEXT,
    "addedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collection_follows" (
    "id" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "collection_follows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "collections_slug_key" ON "collections"("slug");

-- CreateIndex
CREATE INDEX "collections_status_publishedAt_idx" ON "collections"("status", "publishedAt" DESC);

-- CreateIndex
CREATE INDEX "collection_items_createdAt_idx" ON "collection_items"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "collection_items_collectionId_keyId_key" ON "collection_items"("collectionId", "keyId");

-- CreateIndex
CREATE UNIQUE INDEX "collection_items_collectionId_position_key" ON "collection_items"("collectionId", "position");

-- CreateIndex
CREATE INDEX "collection_follows_walletAddress_idx" ON "collection_follows"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "collection_follows_collectionId_walletAddress_key" ON "collection_follows"("collectionId", "walletAddress");

-- AddForeignKey
ALTER TABLE "collection_items" ADD CONSTRAINT "collection_items_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collection_follows" ADD CONSTRAINT "collection_follows_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
