-- CreateTable
CREATE TABLE "acl_whitelist" (
    "id" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "permittedFunctions" TEXT[],
    "addedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "acl_whitelist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "acl_events" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "permittedFunctions" TEXT[],
    "actor" TEXT NOT NULL,
    "signers" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "acl_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "acl_whitelist_contractAddress_key" ON "acl_whitelist"("contractAddress");

-- CreateIndex
CREATE INDEX "acl_whitelist_createdAt_idx" ON "acl_whitelist"("createdAt");

-- CreateIndex
CREATE INDEX "acl_events_contractAddress_idx" ON "acl_events"("contractAddress");

-- CreateIndex
CREATE INDEX "acl_events_createdAt_idx" ON "acl_events"("createdAt");
