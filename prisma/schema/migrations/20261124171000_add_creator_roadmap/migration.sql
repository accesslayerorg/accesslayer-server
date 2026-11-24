-- CreateEnum
CREATE TYPE "RoadmapMilestoneStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'DELAYED', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "roadmap_milestones" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "RoadmapMilestoneStatus" NOT NULL DEFAULT 'PLANNED',
    "position" INTEGER NOT NULL DEFAULT 0,
    "targetDate" TIMESTAMP(3),
    "revisedDate" TIMESTAMP(3),
    "delayReason" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "roadmap_milestones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "milestone_reactions" (
    "id" TEXT NOT NULL,
    "milestoneId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "reaction" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "milestone_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "roadmap_milestones_keyId_position_idx" ON "roadmap_milestones"("keyId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "milestone_reactions_milestoneId_walletAddress_key" ON "milestone_reactions"("milestoneId", "walletAddress");

-- CreateIndex
CREATE INDEX "milestone_reactions_milestoneId_idx" ON "milestone_reactions"("milestoneId");

-- AddForeignKey
ALTER TABLE "milestone_reactions" ADD CONSTRAINT "milestone_reactions_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "roadmap_milestones"("id") ON DELETE CASCADE ON UPDATE CASCADE;
