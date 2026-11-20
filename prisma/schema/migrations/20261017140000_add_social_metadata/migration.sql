-- CreateTable
CREATE TABLE "CreatorSocialMetadata" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "displayName" TEXT,
    "bio" TEXT,
    "avatarCid" TEXT,
    "avatarUrl" TEXT,
    "socialLinks" JSONB,
    "sourceLedger" INTEGER,
    "sourceTxHash" TEXT,
    "sourceEventIndex" INTEGER,
    "socialUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorSocialMetadata_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialMetadataEvent" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "eventIndex" INTEGER NOT NULL,
    "ledger" INTEGER,
    "actor" TEXT,
    "displayName" TEXT,
    "bio" TEXT,
    "avatarCid" TEXT,
    "avatarUrl" TEXT,
    "socialLinks" JSONB,
    "rawPayload" JSONB,
    "socialUpdatedAt" TIMESTAMP(3),
    "indexedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SocialMetadataEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CreatorSocialMetadata_creatorId_key" ON "CreatorSocialMetadata"("creatorId");

-- CreateIndex
CREATE UNIQUE INDEX "SocialMetadataEvent_txHash_eventIndex_key" ON "SocialMetadataEvent"("txHash", "eventIndex");

-- CreateIndex
CREATE INDEX "SocialMetadataEvent_creatorId_idx" ON "SocialMetadataEvent"("creatorId");

-- AddForeignKey
ALTER TABLE "CreatorSocialMetadata" ADD CONSTRAINT "CreatorSocialMetadata_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialMetadataEvent" ADD CONSTRAINT "SocialMetadataEvent_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
