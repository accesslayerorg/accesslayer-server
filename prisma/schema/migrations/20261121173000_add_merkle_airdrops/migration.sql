CREATE TABLE "airdrops" (
    "id" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "creator" TEXT NOT NULL,
    "root" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "airdrops_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "airdrop_leaves" (
    "id" TEXT NOT NULL,
    "airdropId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "amount" DECIMAL(39,0) NOT NULL,
    "index" INTEGER NOT NULL,
    "proof" JSONB NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "claimedLedger" INTEGER,
    "claimedTxHash" TEXT,
    "claimedEventIndex" INTEGER,
    CONSTRAINT "airdrop_leaves_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "airdrop_leaves_positive_amount" CHECK ("amount" > 0 AND "amount" <= 170141183460469231731687303715884105727),
    CONSTRAINT "airdrop_leaves_nonnegative_index" CHECK ("index" >= 0)
);

CREATE UNIQUE INDEX "airdrops_keyId_root_key" ON "airdrops"("keyId", "root");
CREATE INDEX "airdrops_keyId_createdAt_idx" ON "airdrops"("keyId", "createdAt");
CREATE UNIQUE INDEX "airdrop_leaves_airdropId_address_key" ON "airdrop_leaves"("airdropId", "address");
CREATE UNIQUE INDEX "airdrop_leaves_airdropId_index_key" ON "airdrop_leaves"("airdropId", "index");
CREATE UNIQUE INDEX "airdrop_leaves_claimedTxHash_claimedEventIndex_key" ON "airdrop_leaves"("claimedTxHash", "claimedEventIndex");
CREATE INDEX "airdrop_leaves_airdropId_claimedAt_idx" ON "airdrop_leaves"("airdropId", "claimedAt");
ALTER TABLE "airdrop_leaves" ADD CONSTRAINT "airdrop_leaves_airdropId_fkey" FOREIGN KEY ("airdropId") REFERENCES "airdrops"("id") ON DELETE CASCADE ON UPDATE CASCADE;
