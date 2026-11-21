-- CreateTable
CREATE TABLE "KeyAllowlistEntry" (
    "id" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "cap" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KeyAllowlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KeyAllowlistEntry_creatorId_address_key" ON "KeyAllowlistEntry"("creatorId", "address");

-- CreateIndex
CREATE INDEX "KeyAllowlistEntry_creatorId_idx" ON "KeyAllowlistEntry"("creatorId");
