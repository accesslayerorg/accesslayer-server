CREATE TABLE "admin_totp" (
    "userId" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "enabledAt" TIMESTAMP(3),
    "recoveryHashes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "lastUsedStep" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_totp_pkey" PRIMARY KEY ("userId")
);
