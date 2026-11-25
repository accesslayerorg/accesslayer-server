CREATE TABLE "fee_schedules" (
    "keyId" TEXT NOT NULL,
    "startBps" INTEGER NOT NULL,
    "floorBps" INTEGER NOT NULL,
    "decayLedgers" INTEGER NOT NULL,
    "startLedger" INTEGER NOT NULL,
    "locked" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "fee_schedules_pkey" PRIMARY KEY ("keyId")
);
