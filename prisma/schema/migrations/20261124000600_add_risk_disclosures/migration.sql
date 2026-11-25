-- CreateTable
CREATE TABLE "disclosure_versions" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "contentUrl" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "publishedBy" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disclosure_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disclosure_acceptances" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipHash" TEXT NOT NULL,
    "userAgentHash" TEXT NOT NULL,

    CONSTRAINT "disclosure_acceptances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "disclosure_versions_version_key" ON "disclosure_versions"("version");

-- CreateIndex
CREATE INDEX "disclosure_versions_isActive_publishedAt_idx" ON "disclosure_versions"("isActive", "publishedAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "disclosure_acceptances_wallet_versionId_key" ON "disclosure_acceptances"("wallet", "versionId");

-- CreateIndex
CREATE INDEX "disclosure_acceptances_wallet_version_idx" ON "disclosure_acceptances"("wallet", "version");

-- AddForeignKey
ALTER TABLE "disclosure_acceptances" ADD CONSTRAINT "disclosure_acceptances_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "disclosure_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
