CREATE TABLE "trigger_groups" (
    "id" TEXT NOT NULL,
    "wallet" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "totalAmount" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "trigger_groups_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "trigger_groups_wallet_status_idx" ON "trigger_groups"("wallet", "status");
CREATE INDEX "trigger_groups_keyId_status_idx" ON "trigger_groups"("keyId", "status");

CREATE TABLE "trigger_legs" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "triggerPrice" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'armed',
    "firedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    CONSTRAINT "trigger_legs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "trigger_legs_groupId_idx" ON "trigger_legs"("groupId");
CREATE INDEX "trigger_legs_status_idx" ON "trigger_legs"("status");

ALTER TABLE "trigger_legs" ADD CONSTRAINT "trigger_legs_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "trigger_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
