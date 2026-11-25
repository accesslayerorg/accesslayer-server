-- CreateTable
CREATE TABLE "embed_settings" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "allowedDomains" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "embed_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "embed_weekly_loads" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "embed_weekly_loads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "embed_settings_creatorId_key" ON "embed_settings"("creatorId");

-- CreateIndex
CREATE UNIQUE INDEX "embed_weekly_loads_creatorId_weekStart_key" ON "embed_weekly_loads"("creatorId", "weekStart");

-- CreateIndex
CREATE INDEX "embed_weekly_loads_creatorId_weekStart_idx" ON "embed_weekly_loads"("creatorId", "weekStart");

-- AddForeignKey
ALTER TABLE "embed_settings" ADD CONSTRAINT "embed_settings_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "embed_weekly_loads" ADD CONSTRAINT "embed_weekly_loads_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "CreatorProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
