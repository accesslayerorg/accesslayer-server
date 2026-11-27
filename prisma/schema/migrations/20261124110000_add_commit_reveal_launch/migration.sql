-- CreateTable
CREATE TABLE "launch_windows" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "phase" TEXT NOT NULL DEFAULT 'commit',
    "commitEndLedger" INTEGER NOT NULL,
    "revealEndLedger" INTEGER NOT NULL,
    "clearingPrice" DECIMAL(36,7),
    "commitCount" INTEGER NOT NULL DEFAULT 0,
    "revealCount" INTEGER NOT NULL DEFAULT 0,
    "settledTxHash" TEXT,
    "settledEventIndex" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "launch_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "launch_commits" (
    "id" TEXT NOT NULL,
    "launchWindowId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "commitment" TEXT NOT NULL,
    "revealed" BOOLEAN NOT NULL DEFAULT false,
    "amount" DECIMAL(36,7),
    "maxPrice" DECIMAL(36,7),
    "filledAmount" DECIMAL(36,7),
    "fillStatus" TEXT NOT NULL DEFAULT 'pending',
    "commitTxHash" TEXT NOT NULL,
    "commitEventIndex" INTEGER NOT NULL,
    "commitLedger" INTEGER NOT NULL,
    "revealTxHash" TEXT,
    "revealEventIndex" INTEGER,
    "revealLedger" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "launch_commits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "launch_windows_keyId_key" ON "launch_windows"("keyId");
CREATE INDEX "launch_windows_phase_idx" ON "launch_windows"("phase");

-- CreateIndex
CREATE UNIQUE INDEX "launch_commits_commitTxHash_commitEventIndex_key" ON "launch_commits"("commitTxHash", "commitEventIndex");
CREATE UNIQUE INDEX "launch_commits_keyId_wallet_key" ON "launch_commits"("keyId", "wallet");
CREATE INDEX "launch_commits_launchWindowId_revealed_idx" ON "launch_commits"("launchWindowId", "revealed");

-- AddForeignKey
ALTER TABLE "launch_commits" ADD CONSTRAINT "launch_commits_launchWindowId_fkey" FOREIGN KEY ("launchWindowId") REFERENCES "launch_windows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
